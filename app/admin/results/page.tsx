"use client";

/**
 * Result Management Page — full CRUD for examination result records.
 *
 * Features:
 * - Paginated table with search (name, roll number, enrollment) and status filter
 * - View result details in a read-only modal
 * - Create new result records with student info, subject marks, and grades
 * - Edit existing results (update marks, status, CGPA, etc.)
 * - Delete results with confirmation dialog
 *
 * Data flow:
 *   1. GET /api/admin/results — lists results with pagination + search
 *   2. GET /api/admin/results?resultId=X — fetches full result for editing
 *   3. POST /api/admin/results — creates a new result record
 *   4. PUT /api/admin/results — updates an existing result by ID
 *   5. DELETE /api/admin/results — soft-deletes a result by ID
 *
 * Security:
 * - All endpoints are protected by authenticateAdmin() (JWT + role check)
 * - Server-side validation ensures required fields and numeric ranges; the
 *   semester result status is derived by the server (never entered)
 * - Subject marks, grades, and credits are validated at the schema level
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/components/ui/* (Card, Button, Badge, Modal, ConfirmDialog)
 *   - @/components/empty-state, @/components/error-state
 *   - GET/POST/PUT/DELETE /api/admin/results (server-side routes)
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, Filter, Eye, Edit3, ChevronLeft, ChevronRight, FileText, X, Plus, Trash2, Printer } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog, ModalScrollable } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import DocumentViewport from "@/components/results/document-viewport";
import ResultDocument from "@/components/results/result-document";
import { GENDER_OPTIONS, type StatementOfMarks } from "@/components/results/types";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import SearchableSelect from "@/components/ui/searchable-select";
import {
  fetchProgrammeStructure,
  listProgrammeStructures,
} from "@/components/academic-structure/academic-structure-api";
import {
  partitionSubjects,
  semesterLabel,
  type CurriculumSubject,
  type ProgrammeStructureRecord,
  type ProgrammeStructureSummary,
} from "@/components/academic-structure/types";
import { effectiveStatus, type SubjectType } from "@/lib/programme-structure";
import {
  computeSgpa,
  gradeForMarks,
  semesterResultStatus,
  subjectStatus,
} from "@/lib/result-grading";
import styles from "./page.module.css";

interface ResultRecord {
  id: string;
  student: { name: string; rollNumber: string; enrollmentNumber: string; course: string; semester: string };
  totalMarks: number;
  maxTotalMarks: number;
  percentage: number;
  sgpa: number | null;
  cgpa: string | null;
  resultStatus: string;
  declaredDate: string;
  createdAt: string;
}

interface Pagination { page: number; limit: number; total: number; totalPages: number; }

/** One selectable alternative inside an elective group. */
interface ElectiveOption {
  subjectCode: string; subjectName: string; credits: string; subjectType: string; maxMarks: string;
  internalMax: string; externalMax: string; practicalMax: string;
}

interface SubjectEntry {
  subjectCode: string; subjectName: string; internalMarks: string; externalMarks: string;
  totalMarks: string; maxMarks: string; grade: string; gradePoint: string; credits: string;
  /** True when the candidate was absent (stored as grade AB, 0 points). */
  isAbsent: boolean;
  /**
   * Curriculum component maxima (read-only snapshot). Used to cap the + / -
   * controls and to validate typed marks. A practical maximum is entered in the
   * External field, so it is added to the external ceiling.
   */
  internalMax: string;
  externalMax: string;
  practicalMax: string;
  /**
   * Curriculum snapshot metadata from ProgrammeStructure. Read-only in the UI —
   * the admin never types a subject's code, name, credits, type or maximum.
   */
  subjectType: string;
  /** "" = compulsory; otherwise the elective group this subject is an option of. */
  electiveGroup: string;
  /** Alternatives of the elective group (empty for a compulsory subject). */
  electiveOptions: ElectiveOption[];
  isBacklog: boolean;
}

interface FormState {
  /** Programme code selected from ProgrammeStructure (the curriculum identity). */
  programmeCode: string;
  /** Numeric semester within the selected structure. */
  semesterNumber: string;
  studentName: string; rollNumber: string; enrollmentNumber: string;
  /** Optional identity fields snapshotted onto the result (may be blank). */
  fatherName: string; motherName: string; gender: string;
  /** Display values resolved from the structure on the server. */
  course: string; semester: string; academicSession: string;
  collegeName: string; subjects: SubjectEntry[];
  /** Read-only, server-authoritative headline figures (never typed). */
  totalMarks: string; maxTotalMarks: string; percentage: string; sgpa: string; cgpa: string; equivalentPercentage: string;
  resultStatus: string; remarks: string; declaredDate: string;
}

function blankSubject(): SubjectEntry {
  return { subjectCode: "", subjectName: "", internalMarks: "", externalMarks: "", totalMarks: "", maxMarks: "", grade: "", gradePoint: "", credits: "", subjectType: "", electiveGroup: "", electiveOptions: [], isBacklog: false, isAbsent: false, internalMax: "", externalMax: "", practicalMax: "" };
}

function blankForm(): FormState {
  return { programmeCode: "", semesterNumber: "", studentName: "", rollNumber: "", enrollmentNumber: "", fatherName: "", motherName: "", gender: "", course: "", semester: "", academicSession: "", collegeName: "", subjects: [], totalMarks: "", maxTotalMarks: "", percentage: "", sgpa: "", cgpa: "", equivalentPercentage: "", resultStatus: "", remarks: "", declaredDate: "" };
}

/* ── Curriculum → subject rows (Phase 3A) ───────────────────────── */

/** Two programme codes name the same programme (case-insensitive). */
function sameProgramme(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** One subject definition turned into an editable form row (marks blank). */
function entryFromSubject(subject: CurriculumSubject): SubjectEntry {
  return {
    subjectCode: subject.subjectCode,
    subjectName: subject.subjectName,
    credits: String(subject.credits),
    subjectType: subject.subjectType,
    maxMarks: String(subject.assessment.totalMax),
    internalMax: String(subject.assessment.internalMax),
    externalMax: String(subject.assessment.externalMax),
    practicalMax: String(subject.assessment.practicalMax),
    internalMarks: "",
    externalMarks: "",
    totalMarks: "0",
    grade: "",
    gradePoint: "",
    isAbsent: false,
    electiveGroup: "",
    electiveOptions: [],
    isBacklog: false,
  };
}

function optionFromSubject(subject: CurriculumSubject): ElectiveOption {
  return {
    subjectCode: subject.subjectCode,
    subjectName: subject.subjectName,
    credits: String(subject.credits),
    subjectType: subject.subjectType,
    maxMarks: String(subject.assessment.totalMax),
    internalMax: String(subject.assessment.internalMax),
    externalMax: String(subject.assessment.externalMax),
    practicalMax: String(subject.assessment.practicalMax),
  };
}

/**
 * Build the subject rows for one curriculum semester.
 *
 * Compulsory papers become one row each. Each elective group becomes ONE row —
 * its alternatives are offered as a choice — so two options are never turned
 * into two compulsory subjects. Only effectively-active subjects are offered.
 */
function buildCurriculumEntries(
  structure: ProgrammeStructureRecord,
  semesterNumber: number
): SubjectEntry[] {
  const semester = structure.semesters.find(
    (entry) => entry.semesterNumber === semesterNumber
  );
  if (!semester) return [];

  const semesterStatus = effectiveStatus(structure.status, semester.status);
  const active = semester.subjects.filter(
    (subject) => effectiveStatus(semesterStatus, subject.status) === "ACTIVE"
  );
  const { compulsory, groups } = partitionSubjects(active);

  const rows: SubjectEntry[] = compulsory.map(entryFromSubject);

  for (const group of groups) {
    const options = group.options.map(optionFromSubject);
    const first = options[0];
    if (!first) continue;
    rows.push({
      ...entryFromSubject(group.options[0]),
      electiveGroup: group.code,
      electiveOptions: options,
    });
  }

  return rows;
}

/* ── Add Result form helpers ────────────────────────────────────── */

/** True when a form string holds a real number (not empty / not junk). */
function isNumeric(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

/** Parse a form string to a number, falling back to 0. */
function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A subject's total is always internal + external. */
function subjectTotal(sub: SubjectEntry): number {
  if (sub.isAbsent) return 0;
  return num(sub.internalMarks) + num(sub.externalMarks);
}

/**
 * Upper bound for the Internal field — the curriculum's configured internal
 * maximum. Falls back to the total maximum only when no split is available
 * (a subject created before the curriculum integration).
 */
function internalLimitFor(sub: SubjectEntry): number {
  return isNumeric(sub.internalMax) ? num(sub.internalMax) : num(sub.maxMarks);
}

/**
 * Upper bound for the External field. The Result stores only internal + external
 * marks, so a practical component is entered in the External field and its
 * maximum raises this ceiling; for a standard 25/75 paper this is exactly 75.
 * Falls back to the total maximum when no split is available.
 */
function externalLimitFor(sub: SubjectEntry): number {
  if (isNumeric(sub.externalMax) || isNumeric(sub.practicalMax)) {
    return num(sub.externalMax) + num(sub.practicalMax);
  }
  return num(sub.maxMarks);
}

/** Result-level totals derived from the subject list. */
function calcResultTotals(subjects: SubjectEntry[]) {
  const totalMarks = subjects.reduce((sum, sub) => sum + subjectTotal(sub), 0);
  const maxTotalMarks = subjects.reduce((sum, sub) => sum + num(sub.maxMarks), 0);
  const percentage =
    maxTotalMarks > 0 ? Math.round((totalMarks / maxTotalMarks) * 10000) / 100 : 0;
  return { totalMarks, maxTotalMarks, percentage };
}

/**
 * Preview the server-derived status of one subject from the form row. This only
 * mirrors the rule for the admin's benefit — the API recomputes and stores the
 * authoritative value, so the client can never override it.
 */
function formSubjectStatus(sub: SubjectEntry) {
  return subjectStatus({
    totalMarks: subjectTotal(sub),
    maxMarks: num(sub.maxMarks),
    subjectType: (sub.subjectType || null) as SubjectType | null,
    isAbsent: sub.isAbsent,
    isBacklog: sub.isBacklog,
  });
}

/** Preview the server-derived semester result status for a form. */
function formSemesterStatus(form: FormState): "PASS" | "FAIL" {
  return semesterResultStatus(form.subjects.map(formSubjectStatus));
}

/** Map one subject form entry onto the API / model subject shape. */
function buildSubjectPayload(sub: SubjectEntry) {
  // Raw inputs only: grade, grade point and total are DERIVED by the server.
  return {
    subjectCode: sub.subjectCode.trim(),
    subjectName: sub.subjectName.trim(),
    internalMarks: sub.isAbsent ? 0 : num(sub.internalMarks),
    externalMarks: sub.isAbsent ? 0 : num(sub.externalMarks),
    maxMarks: num(sub.maxMarks),
    credits: num(sub.credits),
    subjectType: sub.subjectType || null,
    isAbsent: sub.isAbsent,
    isBacklog: sub.isBacklog,
  };
}

/**
 * POST /api/admin/results payload for the Add Result form.
 *
 * Subject totals plus the result-level total/maximum/percentage are always
 * derived from the subject list, so the saved document can never disagree
 * with its own subjects. CGPA, status, remarks and declared date stay
 * admin-entered, exactly as models/Result.ts defines them.
 */
function buildCreateRequestBody(form: FormState) {
  const subjects = form.subjects.map(buildSubjectPayload);
  const totals = calcResultTotals(form.subjects);
  const body: Record<string, unknown> = {
    student: {
      name: form.studentName.trim(),
      rollNumber: form.rollNumber.trim(),
      enrollmentNumber: form.enrollmentNumber.trim(),
      fatherName: form.fatherName.trim(),
      motherName: form.motherName.trim(),
      gender: form.gender.trim(),
      // Display values — the server re-resolves them from the structure.
      course: form.course.trim(),
      semester: form.semester.trim(),
      academicSession: form.academicSession.trim(),
      collegeName: form.collegeName.trim(),
    },
    subjects,
    totalMarks: totals.totalMarks,
    maxTotalMarks: totals.maxTotalMarks,
    percentage: totals.percentage,
    // SGPA, CGPA and the semester result status are never sent from the form:
    // the server calculates all of them from the subjects.
    remarks: form.remarks.trim(),
    declaredDate: form.declaredDate.trim(),
  };

  // The curriculum identity turns the write into a ProgrammeStructure-driven
  // one; without it the server keeps the existing manual path (used when
  // editing a Result created before the integration).
  if (form.programmeCode && form.academicSession && form.semesterNumber) {
    body.curriculum = {
      programmeCode: form.programmeCode,
      academicSession: form.academicSession,
      semesterNumber: Number(form.semesterNumber),
    };
  }

  return body;
}

/**
 * Client-side pre-flight mirroring models/Result.ts + /api/admin/results, so
 * the admin gets immediate feedback instead of a 400 from the server.
 */
function validateCreateForm(form: FormState): string {
  // ── Academic identity (from ProgrammeStructure) ──
  if (!form.programmeCode) return "Select a programme.";
  if (!form.academicSession) return "Select an academic session.";
  if (!form.semesterNumber) return "Select a semester.";

  const requiredStudentFields: [string, string][] = [
    ["Student name", form.studentName],
    ["Roll number", form.rollNumber],
    ["Enrollment number", form.enrollmentNumber],
    ["College name", form.collegeName],
  ];
  for (const [label, value] of requiredStudentFields) {
    if (!value.trim()) return `${label} is required.`;
  }

  if (form.subjects.length === 0) {
    return "No subjects were loaded — the selected curriculum semester defines none.";
  }

  // Subject code/name/credits/type/maximum are curriculum metadata, resolved
  // and validated server-side; only the obtained marks and grade are entered.
  for (let i = 0; i < form.subjects.length; i++) {
    const sub = form.subjects[i];
    const at = sub.subjectCode || `Subject ${i + 1}`;
    // Absence is a valid, explicit state: its marks are irrelevant (the server
    // clears them), so no mark validation applies to an absent subject.
    if (sub.isAbsent) continue;
    if (!isNumeric(sub.internalMarks) || num(sub.internalMarks) < 0) {
      return `${at}: internal marks must be 0 or more.`;
    }
    if (!isNumeric(sub.externalMarks) || num(sub.externalMarks) < 0) {
      return `${at}: external marks must be 0 or more.`;
    }
    const internalLimit = internalLimitFor(sub);
    if (num(sub.internalMarks) > internalLimit) {
      return `${at}: internal marks cannot exceed the curriculum internal maximum (${internalLimit}).`;
    }
    const externalLimit = externalLimitFor(sub);
    if (num(sub.externalMarks) > externalLimit) {
      return `${at}: external marks cannot exceed the curriculum external maximum (${externalLimit}).`;
    }
    if (subjectTotal(sub) > num(sub.maxMarks)) {
      return `${at}: internal + external marks cannot exceed the curriculum maximum (${sub.maxMarks}).`;
    }
  }

  const totals = calcResultTotals(form.subjects);
  if (totals.maxTotalMarks <= 0) {
    return "Maximum marks must be greater than 0 for at least one subject.";
  }
  if (totals.percentage > 100) {
    return "Total marks cannot exceed the maximum total marks.";
  }
  // The result status is never entered: the server derives it from the subjects
  // (Fail if any subject is Fail/Absent; a Compartment subject never fails it).
  if (!form.declaredDate.trim()) return "Declared date is required.";
  return "";
}

function getStatusVariant(status: string): "success" | "warning" | "danger" | "info" {
  switch (status) { case "PASS": return "success"; case "FAIL": return "danger"; case "COMPARTMENT": return "warning"; default: return "info"; }
}

export default function AdminResultsPage() {
  const [results, setResults] = useState<ResultRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [viewingResult, setViewingResult] = useState<ResultRecord | null>(null);
  const [viewingDocument, setViewingDocument] = useState<StatementOfMarks | null>(null);
  const [viewingLoading, setViewingLoading] = useState(false);
  const [viewingError, setViewingError] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(blankForm());
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");

  const [deletingResult, setDeletingResult] = useState<ResultRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [showEditForm, setShowEditForm] = useState(false);
  const [editingResultId, setEditingResultId] = useState("");
  const [editForm, setEditForm] = useState<FormState>(blankForm());
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [editSuccess, setEditSuccess] = useState("");

  // Programme structures — the curriculum the Add Result form selects from.
  const [structures, setStructures] = useState<ProgrammeStructureSummary[]>([]);
  const [structuresLoading, setStructuresLoading] = useState(true);
  const [structuresError, setStructuresError] = useState("");
  const [structureDetail, setStructureDetail] = useState<ProgrammeStructureRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  // Monotonic request id: only the newest request may write state, so a slow
  // earlier response can never overwrite a newer (filtered) one.
  const requestSeq = useRef(0);

  const fetchResults = useCallback(async (page = 1) => {
    const token = getStoredToken(); if (!token) return;
    const seq = ++requestSeq.current;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: "20" });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/results?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (seq !== requestSeq.current) return;
      if (!res.ok) { setError("Unable to load results."); return; }
      const data = await res.json();
      if (seq !== requestSeq.current) return;
      if (data.success) { setResults(data.data); setPagination(data.pagination); }
    } catch { if (seq === requestSeq.current) setError("Unable to connect to server."); }
    finally { if (seq === requestSeq.current) setLoading(false); }
  }, [search, statusFilter]);

  // Single source of refetch: filter/search handlers only set state — an
  // immediate refetch there would run a stale closure and race this request.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchResults(1);
  }, [fetchResults]);

  const loadStructures = useCallback(async () => {
    setStructuresLoading(true);
    setStructuresError("");
    try {
      // Every structure must be reachable — the server caps one page at 100.
      const all: ProgrammeStructureSummary[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const result = await listProgrammeStructures({ page, limit: 100 });
        if (!result.success) {
          setStructuresError(result.message || "Unable to load programme structures.");
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

  // ── Programme / session / semester options (from ProgrammeStructure) ──

  const programmeOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const structure of structures) {
      const existing = names.get(structure.programmeCode);
      if (existing === undefined || (!existing && structure.programmeName)) {
        names.set(structure.programmeCode, structure.programmeName);
      }
    }
    return Array.from(names, ([code, name]) => ({
      value: code,
      label: code,
      description: name || undefined,
    })).sort((a, b) => a.value.localeCompare(b.value));
  }, [structures]);

  const sessionOptions = useMemo(() => {
    if (!createForm.programmeCode) return [];
    const sessions = new Set<string>();
    for (const structure of structures) {
      if (sameProgramme(structure.programmeCode, createForm.programmeCode)) {
        sessions.add(structure.academicSession);
      }
    }
    return Array.from(sessions)
      .sort((a, b) => b.localeCompare(a))
      .map((value) => ({ value, label: value }));
  }, [structures, createForm.programmeCode]);

  const selectedStructure = useMemo(
    () =>
      structures.find(
        (structure) =>
          sameProgramme(structure.programmeCode, createForm.programmeCode) &&
          structure.academicSession === createForm.academicSession
      ) ?? null,
    [structures, createForm.programmeCode, createForm.academicSession]
  );
  const selectedStructureId = selectedStructure?.id ?? "";

  // The selected programme has no structure at all → tell the admin instead of
  // inventing subjects.
  const structureMissing =
    !!createForm.programmeCode &&
    !structuresLoading &&
    !structuresError &&
    sessionOptions.length === 0;

  const semesterOptions = useMemo(
    () =>
      structureDetail
        ? structureDetail.semesters
            .filter(
              (semester) =>
                effectiveStatus(structureDetail.status, semester.status) === "ACTIVE"
            )
            .sort((a, b) => a.semesterNumber - b.semesterNumber)
        : [],
    [structureDetail]
  );

  // Load the selected structure's curriculum (semesters + subjects).
  useEffect(() => {
    if (!showCreateForm || !selectedStructureId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStructureDetail(null);
      setDetailError("");
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");

    fetchProgrammeStructure(selectedStructureId)
      .then((loaded) => {
        if (cancelled) return;
        setStructureDetail(loaded);
        setDetailLoading(false);
        if (!loaded) setDetailError("Unable to load the selected academic structure.");
      })
      .catch(() => {
        if (cancelled) return;
        setStructureDetail(null);
        setDetailLoading(false);
        setDetailError("Unable to load the selected academic structure.");
      });

    return () => {
      cancelled = true;
    };
  }, [showCreateForm, selectedStructureId]);

  function programmeNameFor(code: string): string {
    return (
      structures.find((structure) => sameProgramme(structure.programmeCode, code))
        ?.programmeName ?? ""
    );
  }

  /** Programme change clears session, semester and every loaded subject. */
  function handleProgrammeChange(value: string) {
    setStructureDetail(null);
    setDetailError("");
    setCreateForm((prev) => ({
      ...prev,
      programmeCode: value,
      course: programmeNameFor(value),
      academicSession: "",
      semesterNumber: "",
      semester: "",
      subjects: [],
    }));
  }

  /** Session change clears semester and every loaded subject. */
  function handleSessionChange(value: string) {
    setStructureDetail(null);
    setDetailError("");
    setCreateForm((prev) => ({
      ...prev,
      academicSession: value,
      semesterNumber: "",
      semester: "",
      subjects: [],
    }));
  }

  /** Semester change loads that semester's subjects from the structure. */
  function handleSemesterChange(value: string) {
    const semester = structureDetail?.semesters.find(
      (entry) => String(entry.semesterNumber) === value
    );
    setCreateForm((prev) => ({
      ...prev,
      semesterNumber: value,
      semester: semester ? semesterLabel(semester) : "",
      subjects:
        structureDetail && value
          ? buildCurriculumEntries(structureDetail, Number(value))
          : [],
    }));
  }

  /** Choosing a different subject within an elective group replaces the row. */
  function changeElectiveOption(index: number, code: string) {
    setCreateForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((sub, i) => {
        if (i !== index) return sub;
        const option = sub.electiveOptions.find((entry) => entry.subjectCode === code);
        if (!option) return sub;
        return {
          ...sub,
          subjectCode: option.subjectCode,
          subjectName: option.subjectName,
          credits: option.credits,
          subjectType: option.subjectType,
          maxMarks: option.maxMarks,
          internalMax: option.internalMax,
          externalMax: option.externalMax,
          practicalMax: option.practicalMax,
          internalMarks: "",
          externalMarks: "",
          totalMarks: "0",
          grade: "",
          gradePoint: "",
        };
      }),
    }));
  }

  function handleSearch(e: React.FormEvent) { e.preventDefault(); fetchResults(1); }
  function formatDate(d: string) { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }

  function updateFormFields(setter: React.Dispatch<React.SetStateAction<FormState>>, field: keyof FormState, value: string | boolean) {
    setter((prev) => ({ ...prev, [field]: value }));
  }

  /**
   * Toggle a subject's absence. The entered marks are CLEARED either way, so a
   * normal → absent change discards what was typed and an absent → normal change
   * starts from a blank (never a stale) value.
   */
  function toggleAbsent(index: number, absent: boolean) {
    setCreateForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((sub, i) =>
        i === index
          ? { ...sub, isAbsent: absent, internalMarks: "", externalMarks: "", totalMarks: "0" }
          : sub
      ),
    }));
  }

  /** Update one subject field and keep its derived total in sync. */
  function updateSubject(index: number, field: keyof SubjectEntry, value: string | boolean) {
    setCreateForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((sub, i) => {
        if (i !== index) return sub;
        const next = { ...sub, [field]: value } as SubjectEntry;
        next.totalMarks = String(subjectTotal(next));
        return next;
      }),
    }));
  }

  /**
   * Toggle a subject's compartment/backlog flag.
   * The flag is reported on the subject row only; it never changes the semester
   * result status (the server derives that from the subject statuses).
   */
  function toggleBacklog(index: number) {
    setCreateForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((sub, i) =>
        i === index ? { ...sub, isBacklog: !sub.isBacklog } : sub
      ),
    }));
  }

  /**
   * PUT payload for the Edit form. It edits the EXISTING Result in place, so
   * the admin-entered headline figures are sent as typed (the create flow is
   * the one that derives them from the curriculum).
   */
  function buildEditRequestBody(form: FormState) {
    return {
      student: { name: form.studentName.trim(), rollNumber: form.rollNumber.trim(), enrollmentNumber: form.enrollmentNumber.trim(), fatherName: form.fatherName.trim(), motherName: form.motherName.trim(), gender: form.gender.trim(), course: form.course.trim(), semester: form.semester.trim(), academicSession: form.academicSession.trim(), collegeName: form.collegeName.trim() },
      subjects: form.subjects.map((sub) => ({ subjectCode: sub.subjectCode.trim(), subjectName: sub.subjectName.trim(), internalMarks: sub.isAbsent ? 0 : Number(sub.internalMarks), externalMarks: sub.isAbsent ? 0 : Number(sub.externalMarks), maxMarks: Number(sub.maxMarks), credits: Number(sub.credits), subjectType: sub.subjectType || null, isAbsent: sub.isAbsent, isBacklog: sub.isBacklog })),
      totalMarks: Number(form.totalMarks), maxTotalMarks: Number(form.maxTotalMarks), percentage: Number(form.percentage), cgpa: form.cgpa.trim(), remarks: form.remarks.trim(), declaredDate: form.declaredDate.trim(),
    };
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault(); if (createLoading) return;
    const validationError = validateCreateForm(createForm);
    if (validationError) { setCreateError(validationError); setCreateSuccess(""); return; }
    setCreateLoading(true); setCreateError(""); setCreateSuccess("");
    const token = getStoredToken(); if (!token) { setCreateError("Not authenticated."); setCreateLoading(false); return; }
    try {
      const res = await fetch("/api/admin/results", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(buildCreateRequestBody(createForm)) });
      const data = await res.json();
      if (!data.success) { setCreateError(data.message || "Failed to create result."); return; }
      setCreateSuccess("Result created!");
      // Show the server-calculated cumulative value before the modal closes.
      setCreateForm((prev) => ({
        ...prev,
        cgpa: data.result?.cgpa ?? "",
        equivalentPercentage:
          data.result?.equivalentPercentage != null
            ? String(data.result.equivalentPercentage)
            : "",
      }));
      setTimeout(() => { setShowCreateForm(false); setCreateSuccess(""); setCreateForm(blankForm()); fetchResults(1); }, 1000);
    } catch { setCreateError("Unable to connect to server."); } finally { setCreateLoading(false); }
  }

  async function openEditForm(result: ResultRecord) {
    setShowEditForm(true); setEditingResultId(result.id); setEditError(""); setEditSuccess("");
    const token = getStoredToken(); if (!token) return;
    try {
      const res = await fetch(`/api/admin/results?resultId=${result.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { setEditError("Unable to load result details."); return; }
      const data = await res.json();
      if (data.success && data.data) {
        const r = data.data;
        setEditForm({
          // The edit flow never re-selects the curriculum identity; it edits the
          // existing Result in place (the stored snapshot is preserved as-is).
          programmeCode: "", semesterNumber: "",
          studentName: r.student.name, rollNumber: r.student.rollNumber, enrollmentNumber: r.student.enrollmentNumber,
          fatherName: r.student.fatherName || "", motherName: r.student.motherName || "", gender: r.student.gender || "",
          course: r.student.course, semester: r.student.semester, academicSession: r.student.academicSession || "", collegeName: r.student.collegeName || "",
          subjects: r.subjects.length > 0 ? r.subjects.map((s: Record<string, unknown>) => ({
            subjectCode: String(s.subjectCode), subjectName: String(s.subjectName), internalMarks: String(s.internalMarks), externalMarks: String(s.externalMarks),
            totalMarks: String(s.totalMarks), maxMarks: String(s.maxMarks), grade: String(s.grade), gradePoint: String(s.gradePoint), credits: String(s.credits),
            subjectType: typeof s.subjectType === "string" ? s.subjectType : "", electiveGroup: "", electiveOptions: [], isBacklog: Boolean(s.isBacklog), isAbsent: Boolean(s.isAbsent),
          })) : [blankSubject()],
          totalMarks: String(r.totalMarks), maxTotalMarks: String(r.maxTotalMarks), percentage: String(r.percentage),
          sgpa: r.sgpa != null ? String(r.sgpa) : "", cgpa: r.cgpa ?? "", equivalentPercentage: r.equivalentPercentage != null ? String(r.equivalentPercentage) : "",
          resultStatus: r.resultStatus, remarks: r.remarks || "", declaredDate: r.declaredDate,
        });
      }
    } catch { setEditError("Unable to connect to server."); }
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault(); if (editLoading || !editingResultId) return;
    setEditLoading(true); setEditError(""); setEditSuccess("");
    const token = getStoredToken(); if (!token) { setEditError("Not authenticated."); setEditLoading(false); return; }
    try {
      const res = await fetch("/api/admin/results", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ resultId: editingResultId, ...buildEditRequestBody(editForm) }) });
      const data = await res.json();
      if (!data.success) { setEditError(data.message || "Failed to update."); return; }
      setEditSuccess("Result updated!");
      setTimeout(() => { setShowEditForm(false); setEditingResultId(""); setEditSuccess(""); setEditForm(blankForm()); fetchResults(pagination.page); }, 1000);
    } catch { setEditError("Unable to connect to server."); } finally { setEditLoading(false); }
  }

  /**
   * Open the official Statement of Marks for one result.
   *
   * The list payload carries headline figures only, so the full document —
   * student block plus subject-wise marks — is fetched on demand from
   * GET /api/admin/results?resultId=…
   */
  async function openViewDocument(result: ResultRecord) {
    setViewingResult(result);
    setViewingDocument(null);
    setViewingError("");
    setViewingLoading(true);

    const token = getStoredToken();
    if (!token) {
      setViewingError("Not authenticated.");
      setViewingLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/admin/results?resultId=${result.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setViewingError("Unable to load the result statement.");
        return;
      }
      const data = await res.json();
      if (data.success && data.data) setViewingDocument(data.data as StatementOfMarks);
      else setViewingError(data.message || "Unable to load the result statement.");
    } catch {
      setViewingError("Unable to connect to server.");
    } finally {
      setViewingLoading(false);
    }
  }

  function closeViewDocument() {
    setViewingResult(null);
    setViewingDocument(null);
    setViewingError("");
  }

  async function handleDelete() {
    if (!deletingResult || deleteLoading) return;
    setDeleteLoading(true);
    const token = getStoredToken(); if (!token) return;
    try {
      const res = await fetch("/api/admin/results", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ resultId: deletingResult.id }) });
      const data = await res.json();
      if (data.success) { setDeletingResult(null); fetchResults(pagination.page); }
    } catch { /* ignore */ } finally { setDeleteLoading(false); setDeletingResult(null); }
  }

  // Derived for the Add Result summary — never stored in form state. The
  // SGPA preview mirrors the server rule exactly (including its grade-point
  // bands), so the figure shown can never disagree with what is saved.
  const createTotals = calcResultTotals(createForm.subjects);
  // Server-derived previews. The admin never selects either value.
  const createSemesterStatus = formSemesterStatus(createForm);
  const editFormSemesterStatus = formSemesterStatus(editForm);
  const createSgpa = useMemo(
    () =>
      computeSgpa(
        createForm.subjects.map((sub) => ({
          credits: num(sub.credits),
          gradePoint: gradeForMarks(subjectTotal(sub), sub.isAbsent).gradePoint,
        }))
      ),
    [createForm.subjects]
  );
  const backlogSubjects = createForm.subjects
    .map((sub, i) => ({ label: sub.subjectCode.trim() || `Subject ${i + 1}`, isBacklog: sub.isBacklog }))
    .filter((sub) => sub.isBacklog)
    .map((sub) => sub.label);
  const hasBacklogSubjects = backlogSubjects.length > 0;

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input type="text" placeholder="Search by name, roll number, or enrollment..." value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (<button type="button" className={styles.clearBtn} onClick={() => { setSearch(""); }}><X size={14} /></button>)}
            </div>
            <Button type="submit" variant="primary" size="sm"><Search size={14} /> Search</Button>
          </form>
          <div className={styles.toolbarRight}>
            <div className={styles.filterRow}>
              <Filter size={14} />
              <SearchableSelect
                id="results-status-filter"
                variant="compact"
                label="Filter by status"
                placeholder="All Status"
                value={statusFilter}
                options={[
                  { value: "", label: "All Status" },
                  { value: "PASS", label: "Pass" },
                  { value: "FAIL", label: "Fail" },
                ]}
                triggerClassName={styles.select}
                onChange={(value) => {
                  setStatusFilter(value);
                }}
              />
            </div>
            <Button variant="primary" size="sm" onClick={() => { setCreateForm(blankForm()); setCreateError(""); setCreateSuccess(""); setStructureDetail(null); setDetailError(""); setShowCreateForm(true); }}><Plus size={14} /> Add Result</Button>
          </div>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader title={`Results (${pagination.total})`} subtitle={`Page ${pagination.page} of ${pagination.totalPages || 1}`} />
        {loading ? (
          <div className={styles.loadingState}><div className={styles.spinner} /><p>Loading results...</p></div>
        ) : error ? (
          <ErrorState title="Unable to load results" description={error} onRetry={() => fetchResults(pagination.page)} />
        ) : results.length === 0 ? (
          <EmptyState icon={<FileText />} title="No results found" description="No result records match your search criteria." />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead><tr><th>Student</th><th>Roll No</th><th>Course</th><th>Semester</th><th>Marks</th><th>SGPA</th><th>CGPA</th><th>Status</th><th>Declared</th><th>Actions</th></tr></thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.id}>
                      <td className={styles.nameCell}>{r.student.name}</td>
                      <td className={styles.monoCell}>{r.student.rollNumber}</td>
                      <td>{r.student.course}</td>
                      <td>{r.student.semester}</td>
                      <td>{r.totalMarks}/{r.maxTotalMarks}</td>
                      <td className={styles.monoCell}>{r.sgpa === null ? "—" : r.sgpa.toFixed(2)}</td>
                      <td className={styles.monoCell}>{r.cgpa || "—"}</td>
                      <td><Badge variant={getStatusVariant(r.resultStatus)}>{r.resultStatus}</Badge></td>
                      <td>{formatDate(r.declaredDate)}</td>
                      <td className={styles.actionsCell}>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openViewDocument(r)} title="View"><Eye size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openEditForm(r)} title="Edit"><Edit3 size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setDeletingResult(r)} title="Delete"><Trash2 size={15} /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile only (<=600px): same results array as the table above,
                rendered as record cards. Hidden on desktop/tablet. */}
            <RecordList>
              {results.map((r) => (
                <RecordCard
                  key={r.id}
                  title={r.student.name}
                  subtitle={`${r.student.rollNumber} · ${r.student.enrollmentNumber}`}
                  actions={
                    <>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openViewDocument(r)} title="View" aria-label={`View statement of marks for ${r.student.name}`}><Eye size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openEditForm(r)} title="Edit" aria-label={`Edit result for ${r.student.name}`}><Edit3 size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => setDeletingResult(r)} title="Delete" aria-label={`Delete result for ${r.student.name}`}><Trash2 size={15} /></Button>
                    </>
                  }
                >
                  <RecordField label="Course">{r.student.course}</RecordField>
                  <RecordField label="Semester">{r.student.semester}</RecordField>
                  <RecordField label="Marks">{r.totalMarks}/{r.maxTotalMarks}</RecordField>
                  <RecordField label="SGPA">{r.sgpa === null ? "—" : r.sgpa.toFixed(2)}</RecordField>
                  <RecordField label="CGPA">{r.cgpa || "—"}</RecordField>
                  <RecordField label="Status"><Badge variant={getStatusVariant(r.resultStatus)}>{r.resultStatus}</Badge></RecordField>
                  <RecordField label="Declared">{formatDate(r.declaredDate)}</RecordField>
                </RecordCard>
              ))}
            </RecordList>

            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button variant="secondary" size="sm" disabled={pagination.page <= 1} onClick={() => fetchResults(pagination.page - 1)}><ChevronLeft size={14} /> Previous</Button>
                <span className={styles.pageInfo}>Page {pagination.page} of {pagination.totalPages}</span>
                <Button variant="secondary" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchResults(pagination.page + 1)}>Next <ChevronRight size={14} /></Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* View Result Modal — official Statement of Marks */}
      <Modal open={!!viewingResult} onClose={closeViewDocument} maxWidth={900}>
        {viewingResult && (
          <>
            <h3 className={styles.modalTitle}>Statement of Marks</h3>
            <p className={styles.modalDesc}>
              {viewingResult.student.name} · {viewingResult.student.rollNumber} · {viewingResult.student.course}
            </p>
            <ModalScrollable>
              {viewingLoading && (
                <div className={styles.loadingState}><div className={styles.spinner} /><p>Loading statement...</p></div>
              )}
              {!viewingLoading && viewingError && (
                <ErrorState title="Unable to load statement" description={viewingError} onRetry={() => openViewDocument(viewingResult)} />
              )}
              {!viewingLoading && !viewingError && viewingDocument && (
                <DocumentViewport className={styles.documentViewport}>
                  <ResultDocument data={viewingDocument} />
                </DocumentViewport>
              )}
            </ModalScrollable>
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={closeViewDocument}>Close</Button>
              <Button variant="primary" onClick={() => window.print()} disabled={!viewingDocument}>
                <Printer size={15} /> Print
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Create Result Modal */}
      <Modal open={showCreateForm} onClose={() => { if (!createLoading) { setShowCreateForm(false); setCreateError(""); setCreateSuccess(""); } }} maxWidth={860}>
        <form onSubmit={handleCreateSubmit}>
          {/* Add Result form — student info, result info, dynamic subjects, summary */}
          <h3 className={styles.modalTitle}>Add New Result</h3>
          <p className={styles.modalDesc}>Choose the programme, academic session and semester first — the subjects (and their credits, type and maximum marks) are loaded from Academic Structure. Enter only the marks obtained (and tick Absent where applicable). Subject total, grade, grade point, percentage, SGPA, CGPA and equivalent percentage are all calculated by the server.</p>
          <ModalScrollable>
            {/* ── Student Information ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Student Information</h4>
              <div className={styles.formGrid}>
                <div className={styles.formField}><label>Student Name *</label><input type="text" placeholder="e.g. Aarav Sharma" value={createForm.studentName} onChange={(e) => updateFormFields(setCreateForm, "studentName", e.target.value)} /></div>
                <div className={styles.formField}><label>Roll Number *</label><input type="text" placeholder="e.g. MSU2024001" value={createForm.rollNumber} onChange={(e) => updateFormFields(setCreateForm, "rollNumber", e.target.value)} /></div>
                <div className={styles.formField}><label>Enrollment Number *</label><input type="text" placeholder="e.g. EN2024CS1001" value={createForm.enrollmentNumber} onChange={(e) => updateFormFields(setCreateForm, "enrollmentNumber", e.target.value)} /></div>
                <div className={styles.formField}><label>Father&apos;s Name</label><input type="text" placeholder="e.g. Rajesh Sharma" value={createForm.fatherName} onChange={(e) => updateFormFields(setCreateForm, "fatherName", e.target.value)} /></div>
                <div className={styles.formField}><label>Mother&apos;s Name</label><input type="text" placeholder="e.g. Sunita Sharma" value={createForm.motherName} onChange={(e) => updateFormFields(setCreateForm, "motherName", e.target.value)} /></div>
                <div className={styles.formField}><label>Gender</label><div className={styles.radioRow} role="radiogroup" aria-label="Gender">{GENDER_OPTIONS.map((option) => (<label key={option} className={styles.radioOption}><input type="radio" name="create-gender" value={option} checked={createForm.gender === option} onChange={() => updateFormFields(setCreateForm, "gender", option)} /><span>{option}</span></label>))}</div></div>
                <div className={styles.formField}><label>College Name *</label><input type="text" placeholder="e.g. University College" value={createForm.collegeName} onChange={(e) => updateFormFields(setCreateForm, "collegeName", e.target.value)} /></div>
              </div>

              {/* Academic identity comes from Academic Structure — never typed. */}
              <div className={styles.formGrid}>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <SearchableSelect id="result-programme" label="Course / Programme" required placeholder="Select a programme…" searchPlaceholder="Type a code (BCA) or name…" emptyMessage="No programme structures are defined yet. Create one in Academic Structure first." noResultsMessage="No programme matches your search." value={createForm.programmeCode} options={programmeOptions} onChange={handleProgrammeChange} loading={structuresLoading} error={structuresError} onRetry={loadStructures} />
                </div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <SearchableSelect id="result-session" label="Academic Session" required placeholder={createForm.programmeCode ? "Select an academic session…" : "Select a programme first"} searchPlaceholder="Type a session (2023-24)…" emptyMessage={createForm.programmeCode ? "This programme has no academic sessions defined yet." : "Select a programme first."} noResultsMessage="No academic session matches your search." value={createForm.academicSession} options={sessionOptions} onChange={handleSessionChange} disabled={!createForm.programmeCode} />
                </div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label>Semester *</label>
                  <select value={createForm.semesterNumber} onChange={(e) => handleSemesterChange(e.target.value)} disabled={!structureDetail || detailLoading || semesterOptions.length === 0} required>
                    <option value="">{detailLoading ? "Loading semesters…" : structureDetail ? "Select a semester…" : "Select a programme and academic session first"}</option>
                    {semesterOptions.map((s) => (<option key={s.semesterNumber} value={s.semesterNumber}>{semesterLabel(s)}</option>))}
                  </select>
                  {detailError && <span className={styles.fieldHint}>{detailError}</span>}
                  {!detailError && structureDetail && semesterOptions.length === 0 && (<span className={styles.fieldHint}>This structure has no active semesters yet. Add them in Academic Structure first.</span>)}
                </div>

                {structureMissing && (
                  <div className={`${styles.formField} ${styles.formFieldFull}`}>
                    <p className={styles.summaryNote}><strong>{createForm.programmeCode}</strong> exists in the programme catalogue but has no academic structure configured, so no session, semester or subject can be loaded. Configure it in Academic Structure first — subjects are never invented here.</p>
                  </div>
                )}
              </div>
            </section>

            {/* ── Result Information ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Result Information</h4>
              <div className={styles.formGrid}>
                <div className={styles.formField}><label>Declared Date *</label><input type="text" placeholder="15 July 2026" value={createForm.declaredDate} onChange={(e) => updateFormFields(setCreateForm, "declaredDate", e.target.value)} /></div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}><label>Remarks</label><input type="text" placeholder="Optional" value={createForm.remarks} onChange={(e) => updateFormFields(setCreateForm, "remarks", e.target.value)} /></div>
              </div>
            </section>

            {/* ── Subjects (loaded from the selected curriculum semester) ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Subjects from Curriculum ({createForm.subjects.length})</h4>
              {!createForm.semesterNumber ? (
                <p className={styles.summaryNote}>Select a programme, academic session and semester to load its subjects from Academic Structure.</p>
              ) : createForm.subjects.length === 0 ? (
                <p className={styles.summaryNote}>This curriculum semester defines no active subjects, so no Result can be recorded for it.</p>
              ) : (
                <div className={styles.subjectList}>
                  {createForm.subjects.map((sub, i) => (
                    <div key={`${sub.electiveGroup || ""}-${sub.subjectCode}-${i}`} className={`${styles.subjectCard} ${sub.isBacklog ? styles.subjectCardBacklog : ""}`}>
                      <div className={styles.subjectCardHeader}>
                        <span className={styles.subjectCardTitle}>{sub.subjectCode} — {sub.subjectName}</span>
                        {sub.electiveGroup && <Badge variant="info">{sub.electiveGroup}</Badge>}
                        {sub.isBacklog && <Badge variant="warning">Compartment</Badge>}
                      </div>
                      {sub.electiveGroup && sub.electiveOptions.length > 1 && (
                        <div className={styles.formField}>
                          <label>{sub.electiveGroup} choice — choose ONE</label>
                          <select value={sub.subjectCode} onChange={(e) => changeElectiveOption(i, e.target.value)}>
                            {sub.electiveOptions.map((option) => (<option key={option.subjectCode} value={option.subjectCode}>{option.subjectCode} — {option.subjectName}</option>))}
                          </select>
                        </div>
                      )}
                      <div className={styles.formGrid}>
                        <div className={`${styles.formField} ${styles.autoField}`}><label>Credits</label><input type="text" value={sub.credits} readOnly tabIndex={-1} /></div>
                        <div className={`${styles.formField} ${styles.autoField}`}><label>Type</label><input type="text" value={sub.subjectType} readOnly tabIndex={-1} /></div>
                        <div className={`${styles.formField} ${styles.autoField}`}><label>Maximum Marks</label><input type="text" value={sub.maxMarks} readOnly tabIndex={-1} /></div>
                        <div className={styles.formField}><label>Internal Marks * (max {internalLimitFor(sub)})</label><input type="number" min={0} max={internalLimitFor(sub)} step={1} inputMode="numeric" placeholder="28" disabled={sub.isAbsent} value={sub.internalMarks} onChange={(e) => updateSubject(i, "internalMarks", e.target.value)} onWheel={(e) => e.currentTarget.blur()} /></div>
                        <div className={styles.formField}><label>External Marks * (max {externalLimitFor(sub)})</label><input type="number" min={0} max={externalLimitFor(sub)} step={1} inputMode="numeric" placeholder="58" disabled={sub.isAbsent} value={sub.externalMarks} onChange={(e) => updateSubject(i, "externalMarks", e.target.value)} onWheel={(e) => e.currentTarget.blur()} /></div>
                        <div className={`${styles.formField} ${styles.autoField}`}><label>Total Marks (auto)</label><input type="number" value={subjectTotal(sub)} readOnly tabIndex={-1} /></div>
                        <div className={`${styles.formField} ${styles.autoField}`}><label>Grade (auto)</label><input type="text" value={gradeForMarks(subjectTotal(sub), sub.isAbsent).grade} readOnly tabIndex={-1} /></div>
                        <div className={`${styles.formField} ${styles.autoField}`}><label>Grade Point (auto)</label><input type="number" value={gradeForMarks(subjectTotal(sub), sub.isAbsent).gradePoint} readOnly tabIndex={-1} /></div>
                      </div>
                      <label className={styles.checkRow}>
                        <input type="checkbox" checked={sub.isAbsent} onChange={(e) => toggleAbsent(i, e.target.checked)} />
                        <span>Absent (AB) — the candidate was absent for this subject (grade AB, 0 points)</span>
                      </label>
                      <label className={styles.checkRow}>
                        <input type="checkbox" checked={sub.isBacklog} onChange={() => toggleBacklog(i)} />
                        <span>Compartment / Backlog — this subject is a compartment subject for this student</span>
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ── Result Summary ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Result Summary</h4>
              <div className={styles.summaryGrid}>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>Total Marks</span><span className={styles.summaryValue}>{createTotals.totalMarks}</span></div>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>Maximum Marks</span><span className={styles.summaryValue}>{createTotals.maxTotalMarks}</span></div>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>Percentage</span><span className={styles.summaryValue}>{createTotals.percentage.toFixed(2)}%</span></div>
                {/* SGPA and CGPA are calculated by the server and are display-only. */}
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>SGPA (auto)</span><span className={styles.summaryValue}>{createSgpa === null ? "—" : createSgpa.toFixed(2)}</span></div>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>CGPA (auto)</span><span className={styles.summaryValue}>{createForm.cgpa.trim() || "Calculated on save"}</span></div>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>Equivalent % (auto)</span><span className={styles.summaryValue}>{createForm.equivalentPercentage.trim() || "Calculated on save"}</span></div>
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label>Result Status (auto)</label>
                  <input type="text" className={styles.autoInput} value={createSemesterStatus} readOnly tabIndex={-1} />
                  <span className={styles.fieldHint}>Calculated from the subject results — Pass unless a subject is Fail or Absent.</span>
                </div>
              </div>
              {hasBacklogSubjects && (<p className={styles.summaryNote}><strong>Compartment subjects:</strong> {backlogSubjects.join(", ")} — each one is saved with its own compartment flag.</p>)}
            </section>
          </ModalScrollable>
          {createError && <p className={styles.formError}>{createError}</p>}
          {createSuccess && <p className={styles.formSuccess}>{createSuccess}</p>}
          <div className={styles.modalActions}>
            <Button type="button" variant="secondary" onClick={() => { setShowCreateForm(false); setCreateError(""); setCreateSuccess(""); }} disabled={createLoading}>Cancel</Button>
            <Button type="submit" variant="primary" loading={createLoading}>Create Result</Button>
          </div>
        </form>
      </Modal>

      {/* Edit Result Modal */}
      <Modal open={showEditForm} onClose={() => { if (!editLoading) { setShowEditForm(false); setEditError(""); setEditSuccess(""); } }} maxWidth={680}>
        <form onSubmit={handleEditSubmit}>
          <h3 className={styles.modalTitle}>Edit Result</h3>
          <ModalScrollable>
            <div className={styles.formFields}>
              <div className={styles.formField}><label>Student Name *</label><input type="text" value={editForm.studentName} onChange={(e) => updateFormFields(setEditForm, "studentName", e.target.value)} /></div>
              <div className={styles.formField}><label>Roll Number *</label><input type="text" value={editForm.rollNumber} onChange={(e) => updateFormFields(setEditForm, "rollNumber", e.target.value)} /></div>
              <div className={styles.formField}><label>Father&apos;s Name</label><input type="text" value={editForm.fatherName} onChange={(e) => updateFormFields(setEditForm, "fatherName", e.target.value)} /></div>
              <div className={styles.formField}><label>Mother&apos;s Name</label><input type="text" value={editForm.motherName} onChange={(e) => updateFormFields(setEditForm, "motherName", e.target.value)} /></div>
              <div className={styles.formField}><label>Gender</label><div className={styles.radioRow} role="radiogroup" aria-label="Gender">{GENDER_OPTIONS.map((option) => (<label key={option} className={styles.radioOption}><input type="radio" name="edit-gender" value={option} checked={editForm.gender === option} onChange={() => updateFormFields(setEditForm, "gender", option)} /><span>{option}</span></label>))}</div></div>
              <div className={`${styles.formField} ${styles.autoField}`}><label>SGPA (auto)</label><input type="text" value={editForm.sgpa || "—"} readOnly tabIndex={-1} /></div>
              <div className={`${styles.formField} ${styles.autoField}`}><label>CGPA (auto)</label><input type="text" value={editForm.cgpa || "—"} readOnly tabIndex={-1} /></div>
              <div className={`${styles.formField} ${styles.autoField}`}><label>Equivalent % (auto)</label><input type="text" value={editForm.equivalentPercentage || "—"} readOnly tabIndex={-1} /></div>
              <div className={styles.formField}><label>Result Status (auto)</label><input type="text" className={styles.autoInput} value={editFormSemesterStatus} readOnly tabIndex={-1} /></div>
              <div className={styles.formField}><label>Declared Date *</label><input type="text" value={editForm.declaredDate} onChange={(e) => updateFormFields(setEditForm, "declaredDate", e.target.value)} /></div>
              <div className={`${styles.formField} ${styles.autoField}`}><label>Total Marks (auto)</label><input type="number" value={editForm.totalMarks || "0"} readOnly tabIndex={-1} /></div>
              <div className={`${styles.formField} ${styles.autoField}`}><label>Max Total Marks (auto)</label><input type="number" value={editForm.maxTotalMarks || "0"} readOnly tabIndex={-1} /></div>
              <div className={`${styles.formField} ${styles.autoField}`}><label>Percentage (auto)</label><input type="number" value={editForm.percentage || "0"} readOnly tabIndex={-1} /></div>
            </div>
          </ModalScrollable>
          {editError && <p className={styles.formError}>{editError}</p>}
          {editSuccess && <p className={styles.formSuccess}>{editSuccess}</p>}
          <div className={styles.modalActions}>
            <Button type="button" variant="secondary" onClick={() => { setShowEditForm(false); setEditError(""); setEditSuccess(""); }} disabled={editLoading}>Cancel</Button>
            <Button type="submit" variant="primary" loading={editLoading}>Update Result</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog open={!!deletingResult} onClose={() => { if (!deleteLoading) setDeletingResult(null); }} onConfirm={handleDelete} title="Delete Result" description={`Delete result for "${deletingResult?.student.name}"? This action cannot be undone.`} confirmLabel="Delete" variant="danger" loading={deleteLoading} />
    </div>
  );
}
