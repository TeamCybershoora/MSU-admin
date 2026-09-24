"use client";

/**
 * Syllabus Management Page — CRUD for the programme/semester syllabus.
 *
 * Two independent layers, managed on the same page:
 *
 * 1. Official Programme Syllabus (one PDF per programme)
 *    → ProgrammeSyllabusPdfCard: View / Replace / Delete of the programme PDF.
 *      Never touches semester or subject records.
 *
 * 2. Structured Syllabus (programme → semester → subjects[])
 *    → Semester cards rendered from data, each with:
 *        Semester: [Edit] [Delete]
 *        Subject : [Edit] [Delete] and [+ Add Subject]
 *        Programme: [Delete Complete Structured Syllabus]
 *      Deleting structured records never touches the official programme PDF.
 *
 * All operations are generic and identifier-based (programme + semester +
 * subjectCode) via components/syllabus/syllabus-api.ts, so the exact same code
 * manages BCA Semester 1 and B.Tech Semester 2 — nothing is hard-coded per
 * programme, semester or subject. Every destructive action is confirmed with a
 * message that states what will and will not be deleted.
 *
 * Data flow:
 *   GET  /api/admin/syllabus              — paginated structured records
 *   POST /api/admin/syllabus              — create/upsert a semester
 *   PATCH /api/admin/syllabus             — update a semester or one subject
 *   DELETE /api/admin/syllabus            — delete subject / semester / all
 *   /api/admin/programme-syllabus         — official programme PDF
 *   /api/admin/syllabus/upload            — shared GridFS PDF storage
 *
 * Security: every endpoint requires an admin JWT and is rate limited
 * server-side; the UI is presentational only.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import ProgrammeSyllabusPdfCard from "@/components/syllabus/programme-syllabus-pdf-card";
import SyllabusSemesterCard from "@/components/syllabus/syllabus-semester-card";
import SyllabusSemesterForm, {
  type SemesterFormValues,
} from "@/components/syllabus/syllabus-semester-form";
import SyllabusSubjectForm from "@/components/syllabus/syllabus-subject-form";
import {
  deleteSemester,
  deleteStructuredSyllabus,
  deleteSubject,
  fetchProgrammeSyllabi,
  listSyllabi,
  saveSyllabus,
  updateSemester,
  updateSubject,
  type ApiOutcome,
} from "@/components/syllabus/syllabus-api";
import type {
  Pagination,
  ProgrammeSyllabusRecord,
  SyllabusFilters,
  SyllabusRecord,
  SyllabusSubject,
} from "@/components/syllabus/types";
import styles from "./page.module.css";

/** A destructive action awaiting confirmation. */
interface PendingDelete {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<void>;
}

export default function AdminSyllabusPage() {
  const [syllabi, setSyllabi] = useState<SyllabusRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [filters, setFilters] = useState<SyllabusFilters>({ programmes: [] });
  const [search, setSearch] = useState("");
  const [programmeFilter, setProgrammeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Official programme-level PDFs (independent of structured records).
  const [programmeDocs, setProgrammeDocs] = useState<ProgrammeSyllabusRecord[]>(
    []
  );

  // Modal state — one form instance serves every programme and semester.
  const [semesterForm, setSemesterForm] = useState<{
    mode: "create" | "edit";
    record: SyllabusRecord | null;
    programme: string;
  } | null>(null);
  const [subjectForm, setSubjectForm] = useState<{
    record: SyllabusRecord;
    subject: SyllabusSubject | null;
  } | null>(null);
  const [viewingSyllabus, setViewingSyllabus] = useState<SyllabusRecord | null>(
    null
  );

  // Destructive-action state — one ConfirmDialog instance for every level.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  const fetchSyllabi = useCallback(
    async (page = 1) => {
      setLoading(true);
      setError("");
      try {
        const result = await listSyllabi({
          page,
          search,
          programme: programmeFilter,
        });

        if (!result.success) {
          setError(result.message || "Unable to load syllabus records.");
          return;
        }

        setSyllabi(result.data ?? []);
        if (result.pagination) setPagination(result.pagination);
        if (result.filters) setFilters(result.filters);
      } finally {
        setLoading(false);
      }
    },
    [search, programmeFilter]
  );

  useEffect(() => {
    fetchSyllabi(1);
  }, [fetchSyllabi]);

  const loadProgrammeSyllabi = useCallback(async () => {
    setProgrammeDocs(await fetchProgrammeSyllabi());
  }, []);

  useEffect(() => {
    loadProgrammeSyllabi();
  }, [loadProgrammeSyllabi]);

  /** Refresh everything a mutation may have changed and surface a message. */
  const afterMutation = useCallback(
    async (message: string) => {
      setActionError("");
      setActionSuccess(message);
      await Promise.all([fetchSyllabi(pagination.page), loadProgrammeSyllabi()]);
      window.setTimeout(() => setActionSuccess(""), 4000);
    },
    [fetchSyllabi, loadProgrammeSyllabi, pagination.page]
  );

  // Programmes known to the admin: those with structured records plus those
  // with only an official programme PDF.
  const programmeOptions = useMemo(
    () =>
      Array.from(
        new Set([...filters.programmes, ...programmeDocs.map((d) => d.programme)])
      ).sort(),
    [filters.programmes, programmeDocs]
  );

  // Structured records grouped by programme, so the same semester card renders
  // for every programme in the list.
  const groupedSyllabi = useMemo(() => {
    const groups = new Map<string, SyllabusRecord[]>();
    for (const record of syllabi) {
      const list = groups.get(record.programme) ?? [];
      list.push(record);
      groups.set(record.programme, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [syllabi]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchSyllabi(1);
  }

  // ── Semester CRUD ────────────────────────────────────────────

  function openAddSemester() {
    setSemesterForm({
      mode: "create",
      record: null,
      programme: programmeFilter,
    });
  }

  function openEditSemester(record: SyllabusRecord) {
    setSemesterForm({ mode: "edit", record, programme: record.programme });
  }

  async function handleSemesterSave(
    values: SemesterFormValues
  ): Promise<ApiOutcome> {
    const target = semesterForm;
    if (!target) return { success: false, message: "No semester selected." };

    if (target.mode === "edit" && target.record) {
      const renumbered = target.record.semester !== values.semester;

      // Nothing changed and the attachment was not touched → no request needed.
      if (!renumbered && values.pdfUrl === undefined) {
        setSemesterForm(null);
        return { success: true, message: "No changes to save." };
      }

      const outcome = await updateSemester(
        target.record.programme,
        target.record.semester,
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
      semester: values.semester,
      subjects: values.subjects ?? [],
      pdfUrl: values.pdfUrl,
      pdfName: values.pdfName,
    });

    if (outcome.success) {
      setSemesterForm(null);
      await afterMutation("Semester added.");
    }
    return outcome;
  }

  // ── Subject CRUD ─────────────────────────────────────────────

  function openAddSubject(record: SyllabusRecord) {
    setSubjectForm({ record, subject: null });
  }

  function openEditSubject(record: SyllabusRecord, subject: SyllabusSubject) {
    setSubjectForm({ record, subject });
  }

  async function handleSubjectSave(values: SyllabusSubject): Promise<ApiOutcome> {
    const target = subjectForm;
    if (!target) return { success: false, message: "No subject selected." };

    const outcome = await updateSubject(
      target.record.programme,
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

  // ── Delete confirmations (one reusable dialog, configurable per level) ──

  function confirmDeleteSubject(
    record: SyllabusRecord,
    subject: SyllabusSubject
  ) {
    setPendingDelete({
      title: `Delete ${subject.subjectCode} from Semester ${record.semester}?`,
      description: `Delete "${subject.subjectCode} — ${subject.subjectName}" from ${record.programme} Semester ${record.semester}? The semester, its other subjects and the official programme PDF are NOT deleted.`,
      confirmLabel: "Delete Subject",
      action: async () => {
        const outcome = await deleteSubject(
          record.programme,
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
      title: `Delete ${record.programme} Semester ${record.semester}?`,
      description: `Delete ${record.programme} Semester ${record.semester} and all of its subjects (${record.subjects.length})? The programme's other semesters and the official programme PDF are NOT deleted.`,
      confirmLabel: "Delete Semester",
      action: async () => {
        const outcome = await deleteSemester(record.programme, record.semester);
        if (outcome.success) {
          await afterMutation(
            `${record.programme} Semester ${record.semester} removed.`
          );
        } else {
          setActionSuccess("");
          setActionError(outcome.message);
        }
      },
    });
  }

  function confirmDeleteStructured(programme: string, semesterCount: number) {
    setPendingDelete({
      title: `Delete the complete ${programme} structured syllabus?`,
      description: `Delete ALL ${programme} semester and subject records (${semesterCount} semester(s))? The official ${programme} programme PDF is NOT deleted, and no other programme is affected.`,
      confirmLabel: "Delete Structured Syllabus",
      action: async () => {
        const outcome = await deleteStructuredSyllabus(programme);
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

  return (
    <div className={styles.page}>
      {/* ── Official Programme Syllabus ─────────────────────────────
          ONE PDF for the whole programme, independent of — and usable
          without — any semester/subject records.                       */}
      <ProgrammeSyllabusPdfCard
        programmes={programmeOptions}
        docs={programmeDocs}
        onChanged={loadProgrammeSyllabi}
      />

      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input
                type="text"
                placeholder="Search by programme or subject..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => {
                    setSearch("");
                    setTimeout(() => fetchSyllabi(1), 0);
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className={styles.filterRow}>
              <Filter size={14} />
              <select
                value={programmeFilter}
                onChange={(e) => {
                  setProgrammeFilter(e.target.value);
                  setTimeout(() => fetchSyllabi(1), 0);
                }}
                className={styles.select}
              >
                <option value="">All Programmes</option>
                {filters.programmes.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="primary" size="sm">
              <Search size={14} /> Search
            </Button>
          </form>
          <Button variant="primary" size="sm" onClick={openAddSemester}>
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
          subtitle="Programme → Semester → Subjects. Manage semesters and subjects individually; the official programme PDF above is separate."
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
            onRetry={() => fetchSyllabi(pagination.page)}
          />
        ) : syllabi.length === 0 ? (
          <EmptyState
            icon={<BookOpen />}
            title="No syllabus found"
            description="No structured syllabus records match your criteria."
          />
        ) : (
          <>
            <div className={styles.programmeGroups}>
              {groupedSyllabi.map(([programme, records]) => (
                <section key={programme} className={styles.programmeBlock}>
                  <div className={styles.programmeHeader}>
                    <h3 className={styles.programmeName}>
                      <GraduationCap size={16} /> {programme}
                    </h3>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() =>
                        confirmDeleteStructured(programme, records.length)
                      }
                      disabled={deleteLoading}
                    >
                      <Trash2 size={14} /> Delete Complete Structured Syllabus
                    </Button>
                  </div>

                  <div className={styles.semesterGrid}>
                    {records.map((record) => (
                      <SyllabusSemesterCard
                        key={record.id}
                        record={record}
                        disabled={deleteLoading}
                        onViewSemester={setViewingSyllabus}
                        onEditSemester={openEditSemester}
                        onDeleteSemester={confirmDeleteSemester}
                        onAddSubject={openAddSubject}
                        onEditSubject={openEditSubject}
                        onDeleteSubject={confirmDeleteSubject}
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
                  onClick={() => fetchSyllabi(pagination.page - 1)}
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
                  onClick={() => fetchSyllabi(pagination.page + 1)}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Read-only view of one semester */}
      <Modal open={!!viewingSyllabus} onClose={() => setViewingSyllabus(null)}>
        {viewingSyllabus && (
          <>
            <h3 className={styles.modalTitle}>
              {viewingSyllabus.programme} — Semester {viewingSyllabus.semester}
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

      {/* Add / edit a semester (same modal for every programme) */}
      <SyllabusSemesterForm
        open={!!semesterForm}
        mode={semesterForm?.mode ?? "create"}
        record={semesterForm?.record ?? null}
        defaultProgramme={semesterForm?.programme ?? ""}
        programmes={programmeOptions}
        onClose={() => setSemesterForm(null)}
        onSave={handleSemesterSave}
      />

      {/* Add / edit ONE subject (same modal for every semester) */}
      <SyllabusSubjectForm
        open={!!subjectForm}
        subject={subjectForm?.subject ?? null}
        programme={subjectForm?.record.programme ?? ""}
        semester={subjectForm?.record.semester ?? 0}
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
