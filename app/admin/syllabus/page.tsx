"use client";

/**
 * Syllabus Management Page — document associations for the academic structure.
 *
 * ARCHITECTURE (Phase 2A): ProgrammeStructure is the single source of truth for
 * academic metadata. This page is a CONSUMER — it associates syllabus DOCUMENTS
 * with an existing academic identity, and never lets an admin type academic
 * data by hand:
 *
 *   Academic Structure (programme + academic session)  ← source of truth
 *            │
 *            ▼
 *   Syllabus Management (documents)
 *     • Full programme PDF   → programme + academic session
 *     • Semester PDF         → programme + academic session + semester
 *     • Subject PDF          → programme + academic session + semester + subject
 *
 * Two layers, both identity-driven:
 *   1. Official Programme Syllabus (one PDF per structure identity)
 *      → ProgrammeSyllabusPdfCard
 *   2. Structured Syllabus (programme → session → semester → subject documents)
 *      → grouped semester cards, each with per-subject document links
 *
 * Legacy documents (created before the integration, with no academic session)
 * are shown in their own group and can only be removed — a session is never
 * guessed for them.
 *
 * Data flow:
 *   GET    /api/admin/academic-structure  — structures (identity selector)
 *   GET    /api/admin/syllabus            — paginated structured documents
 *   POST   /api/admin/syllabus            — create/upsert a semester document
 *   PATCH  /api/admin/syllabus            — update a semester/subject/PDF
 *   DELETE /api/admin/syllabus            — delete subject/semester/identity
 *   /api/admin/programme-syllabus         — official programme PDF
 *   /api/admin/syllabus/upload            — shared GridFS PDF storage
 *
 * Security: every endpoint requires an admin JWT and is rate limited
 * server-side; the UI is presentational only.
 */

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Filter,
  GraduationCap,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import SearchableSelect from "@/components/ui/searchable-select";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import ProgrammeSyllabusPdfCard from "@/components/syllabus/programme-syllabus-pdf-card";
import UploadedSyllabusPanel from "@/components/syllabus/uploaded-syllabus-panel";
import SyllabusSemesterCard from "@/components/syllabus/syllabus-semester-card";
import SyllabusSemesterForm, {
  type SemesterFormValues,
} from "@/components/syllabus/syllabus-semester-form";
import SyllabusSubjectForm from "@/components/syllabus/syllabus-subject-form";
import {
  deleteSemester,
  deleteStructuredSyllabus,
  deleteSubject,
  fetchProgrammeSyllabus,
  listCatalogueProgrammes,
  listSyllabus,
  readUploadedPdf,
  saveSyllabus,
  updateSemester,
  updateSubject,
  uploadSyllabusPdf,
  validatePdfFile,
  type ApiOutcome,
  type CatalogueProgramme,
} from "@/components/syllabus/syllabus-api";
import {
  identityLabel,
  type Pagination,
  type ProgrammeSyllabusRecord,
  type SyllabusFilters,
  type SyllabusRecord,
  type SyllabusSubject,
} from "@/components/syllabus/types";
import {
  fetchProgrammeStructure,
  listProgrammeStructures,
} from "@/components/academic-structure/academic-structure-api";
import type {
  CurriculumSubject,
  ProgrammeStructureRecord,
  ProgrammeStructureSummary,
} from "@/components/academic-structure/types";
import { effectiveStatus } from "@/lib/programme-structure";
import styles from "./page.module.css";

/** A destructive action awaiting confirmation. */
interface PendingDelete {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<void>;
}

/** Structured documents grouped under one academic identity. */
interface IdentityGroup {
  key: string;
  programme: string;
  academicSession: string | null;
  records: SyllabusRecord[];
}

/** Effectively-active subjects of one semester, read from the structure. */
function activeSubjectsOf(
  detail: ProgrammeStructureRecord | null,
  semesterNumber: number
): CurriculumSubject[] {
  if (!detail) return [];
  const semester = detail.semesters.find(
    (s) => s.semesterNumber === semesterNumber
  );
  if (!semester) return [];

  const semesterStatus = effectiveStatus(detail.status, semester.status);
  return semester.subjects.filter(
    (s) => effectiveStatus(semesterStatus, s.status) === "ACTIVE"
  );
}

export default function AdminSyllabusPage() {
  const [syllabus, setSyllabus] = useState<SyllabusRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [filters, setFilters] = useState<SyllabusFilters>({ programmes: [] });
  const [search, setSearch] = useState("");
  const [programmeFilter, setProgrammeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Academic structures — the identity selector's source of truth.
  const [structures, setStructures] = useState<ProgrammeStructureSummary[]>([]);
  const [structuresLoading, setStructuresLoading] = useState(true);
  const [structuresError, setStructuresError] = useState("");
  const [structureDetails, setStructureDetails] = useState<
    Record<string, ProgrammeStructureRecord>
  >({});

  // The existing MSU programme catalogue (public discovery), unioned with the
  // structures so a catalogue-only programme stays selectable.
  const [catalogue, setCatalogue] = useState<CatalogueProgramme[]>([]);

  // Official programme-level PDFs (independent of structured documents).
  const [programmeDocs, setProgrammeDocs] = useState<ProgrammeSyllabusRecord[]>(
    []
  );

  // Subject code whose PDF is currently uploading (one at a time).
  const [busySubjectCode, setBusySubjectCode] = useState<string | null>(null);

  // Modal state — one form instance serves every structure and semester.
  const [semesterForm, setSemesterForm] = useState<{
    mode: "create" | "edit";
    record: SyllabusRecord | null;
  } | null>(null);
  const [subjectForm, setSubjectForm] = useState<{
    record: SyllabusRecord;
    subject: SyllabusSubject | null;
  } | null>(null);
  const [subjectFormSubjects, setSubjectFormSubjects] = useState<
    CurriculumSubject[]
  >([]);
  const [viewingSyllabus, setViewingSyllabus] = useState<SyllabusRecord | null>(
    null
  );

  // Destructive-action state — one ConfirmDialog instance for every level.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  // Which view of this section is open. Both views live on ONE page (and one
  // route), so adding the read-only listing introduces no duplicate page.
  const [view, setView] = useState<"manage" | "uploaded">("manage");

  // Monotonic request id: only the newest request may write state, so a slow
  // earlier response can never overwrite a newer (filtered) one.
  const requestSeq = useRef(0);

  const fetchSyllabus = useCallback(
    async (page = 1) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError("");
      try {
        const result = await listSyllabus({
          page,
          search,
          programme: programmeFilter,
        });

        if (seq !== requestSeq.current) return;
        if (!result.success) {
          setError(result.message || "Unable to load syllabus records.");
          return;
        }

        setSyllabus(result.data ?? []);
        if (result.pagination) setPagination(result.pagination);
        if (result.filters) setFilters(result.filters);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [search, programmeFilter]
  );

  // Single source of refetch: filter/search handlers only set state — an
  // immediate refetch there would run a stale closure and race this request.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSyllabus(1);
  }, [fetchSyllabus]);

  const loadStructures = useCallback(async () => {
    setStructuresLoading(true);
    setStructuresError("");
    try {
      // The searchable selectors must be able to reach EVERY structure, and the
      // server caps one page at 100 — so walk the pages and join them.
      const all: ProgrammeStructureSummary[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const result = await listProgrammeStructures({ page, limit: 100 });
        if (!result.success) {
          setStructuresError(
            result.message || "Unable to load programme structures."
          );
          return;
        }
        all.push(...(result.data ?? []));
        totalPages = result.pagination?.totalPages ?? 1;
        page += 1;
      } while (page <= totalPages && page <= 50);

      setStructures(all);
    } catch {
      setStructuresError("Unable to load programme structures.");
    } finally {
      setStructuresLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStructures();
  }, [loadStructures]);

  const loadCatalogue = useCallback(async () => {
    setCatalogue(await listCatalogueProgrammes());
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCatalogue();
  }, [loadCatalogue]);

  /** Reload the structure list AND the catalogue (after an explicit create). */
  const refreshStructureSources = useCallback(async () => {
    await Promise.all([loadStructures(), loadCatalogue()]);
  }, [loadStructures, loadCatalogue]);

  const loadProgrammeSyllabus = useCallback(async () => {
    setProgrammeDocs(await fetchProgrammeSyllabus());
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProgrammeSyllabus();
  }, [loadProgrammeSyllabus]);

  /** Load (and cache) one structure's full curriculum for the selectors. */
  const ensureStructureDetail = useCallback(
    async (structureId: string): Promise<ProgrammeStructureRecord | null> => {
      if (!structureId) return null;
      const cached = structureDetails[structureId];
      if (cached) return cached;

      const loaded = await fetchProgrammeStructure(structureId);
      if (loaded) {
        setStructureDetails((prev) => ({ ...prev, [structureId]: loaded }));
      }
      return loaded;
    },
    [structureDetails]
  );

  /** Refresh everything a mutation may have changed and surface a message. */
  const afterMutation = useCallback(
    async (message: string) => {
      setActionError("");
      setActionSuccess(message);
      await Promise.all([
        fetchSyllabus(pagination.page),
        loadProgrammeSyllabus(),
        loadStructures(),
        loadCatalogue(),
      ]);
      window.setTimeout(() => setActionSuccess(""), 4000);
    },
    [
      fetchSyllabus,
      loadProgrammeSyllabus,
      loadStructures,
      loadCatalogue,
      pagination.page,
    ]
  );

  const programmeOptions = useMemo(
    () =>
      Array.from(new Set(filters.programmes)).sort(),
    [filters.programmes]
  );

  // Structured documents grouped by academic identity (programme + session);
  // legacy session-less documents form their own group.
  const groupedSyllabus = useMemo<IdentityGroup[]>(() => {
    const groups = new Map<string, IdentityGroup>();

    for (const record of syllabus) {
      const key = `${record.programme}::${record.academicSession ?? ""}`;
      const group = groups.get(key) ?? {
        key,
        programme: record.programme,
        academicSession: record.academicSession,
        records: [],
      };
      group.records.push(record);
      groups.set(key, group);
    }

    return Array.from(groups.values()).sort((a, b) => {
      if (a.programme !== b.programme) return a.programme.localeCompare(b.programme);
      if (a.academicSession === null) return 1;
      if (b.academicSession === null) return -1;
      return a.academicSession.localeCompare(b.academicSession);
    });
  }, [syllabus]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchSyllabus(1);
  }

  // ── Semester CRUD ────────────────────────────────────────────

  function openAddSemester() {
    setSemesterForm({ mode: "create", record: null });
  }

  function openEditSemester(record: SyllabusRecord) {
    setSemesterForm({ mode: "edit", record });
  }

  async function handleSemesterSave(
    values: SemesterFormValues
  ): Promise<ApiOutcome> {
    const target = semesterForm;
    if (!target) return { success: false, message: "No semester selected." };

    if (target.mode === "edit" && target.record) {
      const { record } = target;
      if (!record.academicSession) {
        return {
          success: false,
          message:
            "This is a legacy document without an academic session and cannot be edited.",
        };
      }

      const renumbered = record.semester !== values.semester;

      // Nothing changed and the attachment was not touched → no request needed.
      if (!renumbered && values.pdfUrl === undefined) {
        setSemesterForm(null);
        return { success: true, message: "No changes to save." };
      }

      const outcome = await updateSemester(
        record.programme,
        record.academicSession,
        record.semester,
        {
          ...(renumbered ? { semesterNumber: values.semester } : {}),
          pdfUrl: values.pdfUrl,
          pdfName: values.pdfName,
        }
      );

      if (outcome.success) {
        setSemesterForm(null);
        await afterMutation(
          renumbered
            ? `Semester renumbered to ${values.semester}.`
            : "Semester updated."
        );
      }
      return outcome;
    }

    const outcome = await saveSyllabus({
      programme: values.programme,
      academicSession: values.academicSession,
      semester: values.semester,
      pdfUrl: values.pdfUrl,
      pdfName: values.pdfName,
    });

    if (outcome.success) {
      setSemesterForm(null);
      await afterMutation("Semester document added.");
    }
    return outcome;
  }

  // ── Subject CRUD ─────────────────────────────────────────────

  async function openAddSubject(record: SyllabusRecord) {
    const detail = await loadDetailFor(record);
    setSubjectFormSubjects(activeSubjectsOf(detail, record.semester));
    setSubjectForm({ record, subject: null });
  }

  async function openEditSubject(record: SyllabusRecord, subject: SyllabusSubject) {
    const detail = await loadDetailFor(record);
    setSubjectFormSubjects(activeSubjectsOf(detail, record.semester));
    setSubjectForm({ record, subject });
  }

  /** Structure detail for a non-legacy record (null for legacy/unknown). */
  async function loadDetailFor(
    record: SyllabusRecord
  ): Promise<ProgrammeStructureRecord | null> {
    if (!record.academicSession) return null;
    const summary = structures.find(
      (s) =>
        s.programmeCode === record.programme &&
        s.academicSession === record.academicSession
    );
    return summary ? ensureStructureDetail(summary.id) : null;
  }

  async function handleSubjectSave(values: SyllabusSubject): Promise<ApiOutcome> {
    const target = subjectForm;
    if (!target) return { success: false, message: "No subject selected." };
    if (!target.record.academicSession) {
      return {
        success: false,
        message:
          "This is a legacy document without an academic session and cannot be edited.",
      };
    }

    const outcome = await updateSubject(
      target.record.programme,
      target.record.academicSession,
      target.record.semester,
      values,
      target.subject?.subjectCode
    );

    if (outcome.success) {
      setSubjectForm(null);
      await afterMutation(target.subject ? "Subject updated." : "Subject added.");
    }
    return outcome;
  }

  // ── Subject PDF documents (upload / replace / remove the ATTACHMENT) ──

  /**
   * Upload a subject's PDF directly from its row and attach it to the SAME
   * academic identity the subject belongs to. The subject itself is untouched.
   */
  async function handleUploadSubjectPdf(
    record: SyllabusRecord,
    subject: SyllabusSubject,
    file: File
  ) {
    if (!record.academicSession) {
      setActionError(
        "This is a legacy document without an academic session and cannot be edited."
      );
      return;
    }

    const problem = validatePdfFile(file);
    if (problem) {
      setActionSuccess("");
      setActionError(problem);
      return;
    }

    setActionError("");
    setBusySubjectCode(subject.subjectCode);
    try {
      const upload = await uploadSyllabusPdf(file);
      if (!upload.success) {
        setActionError(upload.message);
        return;
      }

      const stored = readUploadedPdf(upload.body);
      if (!stored.pdfUrl) {
        setActionError("PDF upload failed.");
        return;
      }

      const outcome = await updateSubject(
        record.programme,
        record.academicSession,
        record.semester,
        { ...subject, pdfUrl: stored.pdfUrl },
        subject.subjectCode
      );

      if (outcome.success) {
        await afterMutation(`${subject.subjectCode} PDF saved.`);
      } else {
        setActionSuccess("");
        setActionError(outcome.message);
      }
    } finally {
      setBusySubjectCode(null);
    }
  }

  /**
   * Clear a subject's PDF attachment ONLY. The academic subject defined in
   * ProgrammeStructure is never removed from anywhere.
   */
  async function handleRemoveSubjectPdf(
    record: SyllabusRecord,
    subject: SyllabusSubject
  ) {
    if (!record.academicSession) {
      setActionError(
        "This is a legacy document without an academic session and cannot be edited."
      );
      return;
    }

    setActionError("");
    try {
      const outcome = await updateSubject(
        record.programme,
        record.academicSession,
        record.semester,
        { ...subject, pdfUrl: null },
        subject.subjectCode
      );

      if (outcome.success) {
        await afterMutation(`${subject.subjectCode} PDF removed.`);
      } else {
        setActionSuccess("");
        setActionError(outcome.message);
      }
    } finally {
      setBusySubjectCode(null);
    }
  }

  // ── Delete confirmations (one reusable dialog, configurable per level) ──

  function confirmDeleteSubject(
    record: SyllabusRecord,
    subject: SyllabusSubject
  ) {
    const canDelete = !!record.academicSession;
    setPendingDelete({
      title: `Delete ${subject.subjectCode} from Semester ${record.semester}?`,
      description: `Delete "${
        subject.subjectCode
      } — ${subject.subjectName}" from ${identityLabel(
        record.programme,
        record.academicSession
      )} Semester ${record.semester}? The semester, its other subjects and the official programme PDF are NOT deleted.${
        canDelete ? "" : " Legacy document: only removal is offered."
      }`,
      confirmLabel: "Delete Subject",
      action: async () => {
        const outcome = await deleteSubject(
          record.programme,
          record.academicSession ?? "",
          record.semester,
          subject.subjectCode
        );
        if (outcome.success) {
          await afterMutation(`${subject.subjectCode} removed.`);
        } else {
          setActionSuccess("");
          setActionError(outcome.message);
        }
      },
    });
  }

  function confirmDeleteSemester(record: SyllabusRecord) {
    setPendingDelete({
      title: `Delete ${identityLabel(
        record.programme,
        record.academicSession
      )} Semester ${record.semester}?`,
      description: `Delete this semester document and all of its subjects (${
        record.subjects.length
      })? Other semesters of the identity and the official programme PDF are NOT deleted.`,
      confirmLabel: "Delete Semester",
      action: async () => {
        const outcome = await deleteSemester(
          record.programme,
          record.academicSession ?? "",
          record.semester
        );
        if (outcome.success) {
          await afterMutation(
            `${identityLabel(record.programme, record.academicSession)} Semester ${
              record.semester
            } removed.`
          );
        } else {
          setActionSuccess("");
          setActionError(outcome.message);
        }
      },
    });
  }

  function confirmDeleteStructured(group: IdentityGroup) {
    setPendingDelete({
      title: `Delete the complete ${identityLabel(
        group.programme,
        group.academicSession
      )} structured syllabus?`,
      description: `Delete ALL semester and subject documents of ${identityLabel(
        group.programme,
        group.academicSession
      )} (${group.records.length} semester(s))? The official programme PDF is NOT deleted, the academic structure is NOT changed, and no other identity is affected.`,
      confirmLabel: "Delete Structured Syllabus",
      action: async () => {
        const outcome = await deleteStructuredSyllabus(
          group.programme,
          group.academicSession ?? ""
        );
        if (outcome.success) {
          await afterMutation(outcome.message);
        } else {
          setActionSuccess("");
          setActionError(outcome.message);
        }
      },
    });
  }

  async function runPendingDelete() {
    const pending = pendingDelete;
    if (!pending) return;

    setDeleteLoading(true);
    setActionError("");
    try {
      await pending.action();
    } finally {
      setDeleteLoading(false);
      setPendingDelete(null);
    }
  }

  /*
   * Section switch. A segmented control (not a strict tablist) because both
   * views are rendered by this single page and route: "Manage Syllabus" is the
   * existing management UI, "Uploaded Syllabus" the read-only listing of
   * documents that are already stored.
   */
  const sectionSwitch = (
    <div className={styles.tabs} role="group" aria-label="Syllabus section">
      <button
        type="button"
        aria-pressed={view === "manage"}
        className={`${styles.tab} ${view === "manage" ? styles.tabActive : ""}`}
        onClick={() => setView("manage")}
      >
        Manage Syllabus
      </button>
      <button
        type="button"
        aria-pressed={view === "uploaded"}
        className={`${styles.tab} ${view === "uploaded" ? styles.tabActive : ""}`}
        onClick={() => setView("uploaded")}
      >
        Uploaded Syllabus
      </button>
    </div>
  );

  // Read-only view: an early return keeps the existing management JSX untouched
  // (its data loading stays exactly as it was).
  if (view === "uploaded") {
    return (
      <div className={styles.page}>
        {sectionSwitch}
        <UploadedSyllabusPanel />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {sectionSwitch}

      {/* ── Official Programme Syllabus ─────────────────────────────
          ONE PDF per ProgrammeStructure identity (programme + session),
          independent of — and usable without — any semester records.     */}
      <ProgrammeSyllabusPdfCard
        structures={structures}
        catalogue={catalogue}
        structuresLoading={structuresLoading}
        structuresError={structuresError}
        onRetryStructures={loadStructures}
        onRefreshStructures={refreshStructureSources}
        docs={programmeDocs}
        onChanged={loadProgrammeSyllabus}
      />

      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input
                type="text"
                placeholder="Search by programme, session or subject..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => {
                    setSearch("");
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className={styles.filterRow}>
              <Filter size={14} />
              <SearchableSelect
                id="syllabus-programme-filter"
                variant="compact"
                label="Filter by programme"
                placeholder="All Programmes"
                value={programmeFilter}
                options={[
                  { value: "", label: "All Programmes" },
                  ...programmeOptions.map((p) => ({ value: p, label: p })),
                ]}
                triggerClassName={styles.select}
                onChange={(value) => {
                  setProgrammeFilter(value);
                }}
              />
            </div>
            <Button type="submit" variant="primary" size="sm">
              <Search size={14} /> Search
            </Button>
          </form>
          <Button
            variant="primary"
            size="sm"
            onClick={openAddSemester}
            disabled={structures.length === 0}
            title={
              structures.length === 0
                ? "Create a programme structure in Academic Structure first"
                : "Attach a semester document"
            }
          >
            <Plus size={14} /> Add Semester
          </Button>
        </div>

        {actionError && <p className={styles.formError}>{actionError}</p>}
        {actionSuccess && <p className={styles.formSuccess}>{actionSuccess}</p>}
      </Card>

      {/* ── Structured Syllabus ─────────────────────────────────── */}
      <Card className={styles.section}>
        <CardHeader
          title={`Structured Syllabus (${pagination.total})`}
          subtitle="Semester and subject documents attached to an academic structure. Academic details are managed in Academic Structure; the official programme PDF above is separate."
        />
        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading syllabus...</p>
          </div>
        ) : error ? (
          <ErrorState
            title="Unable to load syllabus"
            description={error}
            onRetry={() => fetchSyllabus(pagination.page)}
          />
        ) : syllabus.length === 0 ? (
          <EmptyState
            icon={<BookOpen />}
            title="No syllabus documents found"
            description="No structured syllabus documents match your criteria."
          />
        ) : (
          <>
            <div className={styles.programmeGroups}>
              {groupedSyllabus.map((group) => (
                <section key={group.key} className={styles.programmeBlock}>
                  <div className={styles.programmeHeader}>
                    <h3 className={styles.programmeName}>
                      <GraduationCap size={16} />{" "}
                      {identityLabel(group.programme, group.academicSession)}
                    </h3>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => confirmDeleteStructured(group)}
                      disabled={deleteLoading}
                    >
                      <Trash2 size={14} /> Delete Structured Syllabus
                    </Button>
                  </div>

                  <div className={styles.semesterGrid}>
                    {group.records.map((record) => (
                      <SyllabusSemesterCard
                        key={record.id}
                        record={record}
                        legacy={record.academicSession === null}
                        disabled={deleteLoading}
                        onViewSemester={setViewingSyllabus}
                        onEditSemester={openEditSemester}
                        onDeleteSemester={confirmDeleteSemester}
                        onAddSubject={openAddSubject}
                        onEditSubject={openEditSubject}
                        onDeleteSubject={confirmDeleteSubject}
                        onUploadSubjectPdf={handleUploadSubjectPdf}
                        onRemoveSubjectPdf={handleRemoveSubjectPdf}
                        uploadingSubjectCode={busySubjectCode}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>

            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => fetchSyllabus(pagination.page - 1)}
                >
                  <ChevronLeft size={14} /> Previous
                </Button>
                <span className={styles.pageInfo}>
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => fetchSyllabus(pagination.page + 1)}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Read-only view of one semester document */}
      <Modal open={!!viewingSyllabus} onClose={() => setViewingSyllabus(null)}>
        {viewingSyllabus && (
          <>
            <h3 className={styles.modalTitle}>
              {identityLabel(
                viewingSyllabus.programme,
                viewingSyllabus.academicSession
              )}{" "}
              — Semester {viewingSyllabus.semester}
            </h3>
            <div className={styles.formFields}>
              {viewingSyllabus.subjects.map((sub, i) => (
                <div key={i} className={styles.formField}>
                  <label>{sub.subjectCode}</label>
                  <span className={styles.mutedText}>{sub.subjectName}</span>
                </div>
              ))}
              <div className={styles.formField}>
                <label>Semester PDF</label>
                {viewingSyllabus.pdfUrl ? (
                  <a
                    className={styles.pdfLink}
                    href={viewingSyllabus.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {viewingSyllabus.pdfName || "View PDF"}
                  </a>
                ) : (
                  <span className={styles.mutedText}>No semester PDF attached</span>
                )}
              </div>
            </div>
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setViewingSyllabus(null)}>
                Close
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Add / edit a semester document (same modal for every structure) */}
      <SyllabusSemesterForm
        open={!!semesterForm}
        mode={semesterForm?.mode ?? "create"}
        record={semesterForm?.record ?? null}
        structures={structures}
        catalogue={catalogue}
        structuresLoading={structuresLoading}
        structuresError={structuresError}
        onRetryStructures={loadStructures}
        onRefreshStructures={refreshStructureSources}
        onClose={() => setSemesterForm(null)}
        onSave={handleSemesterSave}
      />

      {/* Add / edit ONE subject document (same modal for every semester) */}
      <SyllabusSubjectForm
        open={!!subjectForm}
        subject={subjectForm?.subject ?? null}
        programme={subjectForm?.record.programme ?? ""}
        academicSession={subjectForm?.record.academicSession ?? null}
        semester={subjectForm?.record.semester ?? 0}
        availableSubjects={subjectFormSubjects}
        attachedCodes={(subjectForm?.record.subjects ?? []).map(
          (s) => s.subjectCode
        )}
        onClose={() => setSubjectForm(null)}
        onSave={handleSubjectSave}
      />

      {/* One reusable confirmation dialog for every destructive action */}
      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => {
          if (!deleteLoading) setPendingDelete(null);
        }}
        onConfirm={runPendingDelete}
        title={pendingDelete?.title ?? ""}
        description={pendingDelete?.description ?? ""}
        confirmLabel={pendingDelete?.confirmLabel ?? "Delete"}
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
