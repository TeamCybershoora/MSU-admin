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
 * - Server-side validation ensures required fields, numeric ranges, and
 *   valid result statuses (PASS/FAIL/COMPARTMENT)
 * - Subject marks, grades, and credits are validated at the schema level
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/components/ui/* (Card, Button, Badge, Modal, ConfirmDialog)
 *   - @/components/empty-state, @/components/error-state
 *   - GET/POST/PUT/DELETE /api/admin/results (server-side routes)
 */

import { useState, useEffect, useCallback } from "react";
import { Search, Filter, Eye, Edit3, ChevronLeft, ChevronRight, FileText, X, Plus, Trash2 } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog, ModalScrollable } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

interface ResultRecord {
  id: string;
  student: { name: string; rollNumber: string; enrollmentNumber: string; course: string; semester: string };
  totalMarks: number;
  maxTotalMarks: number;
  percentage: number;
  cgpa: string;
  resultStatus: string;
  declaredDate: string;
  createdAt: string;
}

interface Pagination { page: number; limit: number; total: number; totalPages: number; }

interface SubjectEntry {
  subjectCode: string; subjectName: string; internalMarks: string; externalMarks: string;
  totalMarks: string; maxMarks: string; grade: string; gradePoint: string; credits: string; isBacklog: boolean;
}

interface FormState {
  studentName: string; rollNumber: string; enrollmentNumber: string; course: string; semester: string;
  academicSession: string; collegeName: string; subjects: SubjectEntry[];
  totalMarks: string; maxTotalMarks: string; percentage: string; cgpa: string;
  resultStatus: string; remarks: string; declaredDate: string;
}

function blankSubject(): SubjectEntry {
  return { subjectCode: "", subjectName: "", internalMarks: "", externalMarks: "", totalMarks: "", maxMarks: "", grade: "", gradePoint: "", credits: "", isBacklog: false };
}

function blankForm(): FormState {
  return { studentName: "", rollNumber: "", enrollmentNumber: "", course: "", semester: "", academicSession: "", collegeName: "", subjects: [blankSubject()], totalMarks: "", maxTotalMarks: "", percentage: "", cgpa: "", resultStatus: "", remarks: "", declaredDate: "" };
}

/* ── Add Result form helpers ────────────────────────────────────── */

/** Maximum number of subject cards the Add Result form will render. */
const MAX_SUBJECTS = 20;

/** Subject-code rule mirrored from models/Result.ts. */
const SUBJECT_CODE_PATTERN = /^[A-Za-z0-9]+$/;

/** Grade-letter rule mirrored from models/Result.ts. */
const GRADE_PATTERN = /^[A-Za-z+#-]+$/;

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
  return num(sub.internalMarks) + num(sub.externalMarks);
}

/** Grow/shrink the subject list, keeping already-typed entries. */
function resizeSubjects(subjects: SubjectEntry[], count: number): SubjectEntry[] {
  const target = Math.min(MAX_SUBJECTS, Math.max(1, Math.floor(count) || 1));
  if (target === subjects.length) return subjects;
  if (target < subjects.length) return subjects.slice(0, target);
  return [...subjects, ...Array.from({ length: target - subjects.length }, blankSubject)];
}

/** Result-level totals derived from the subject list. */
function calcResultTotals(subjects: SubjectEntry[]) {
  const totalMarks = subjects.reduce((sum, sub) => sum + subjectTotal(sub), 0);
  const maxTotalMarks = subjects.reduce((sum, sub) => sum + num(sub.maxMarks), 0);
  const percentage =
    maxTotalMarks > 0 ? Math.round((totalMarks / maxTotalMarks) * 10000) / 100 : 0;
  return { totalMarks, maxTotalMarks, percentage };
}

/** Map one subject form entry onto the API / model subject shape. */
function buildSubjectPayload(sub: SubjectEntry) {
  return {
    subjectCode: sub.subjectCode.trim(),
    subjectName: sub.subjectName.trim(),
    internalMarks: num(sub.internalMarks),
    externalMarks: num(sub.externalMarks),
    totalMarks: subjectTotal(sub),
    maxMarks: num(sub.maxMarks),
    grade: sub.grade.trim(),
    gradePoint: num(sub.gradePoint),
    credits: num(sub.credits),
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
  return {
    student: {
      name: form.studentName.trim(),
      rollNumber: form.rollNumber.trim(),
      enrollmentNumber: form.enrollmentNumber.trim(),
      course: form.course.trim(),
      semester: form.semester.trim(),
      academicSession: form.academicSession.trim(),
      collegeName: form.collegeName.trim(),
    },
    subjects,
    totalMarks: totals.totalMarks,
    maxTotalMarks: totals.maxTotalMarks,
    percentage: totals.percentage,
    cgpa: form.cgpa.trim(),
    resultStatus: form.resultStatus,
    remarks: form.remarks.trim(),
    declaredDate: form.declaredDate.trim(),
  };
}

/**
 * Client-side pre-flight mirroring models/Result.ts + /api/admin/results, so
 * the admin gets immediate feedback instead of a 400 from the server.
 */
function validateCreateForm(form: FormState): string {
  const requiredStudentFields: [string, string][] = [
    ["Student name", form.studentName],
    ["Roll number", form.rollNumber],
    ["Enrollment number", form.enrollmentNumber],
    ["Course", form.course],
    ["Semester", form.semester],
    ["Academic session", form.academicSession],
    ["College name", form.collegeName],
  ];
  for (const [label, value] of requiredStudentFields) {
    if (!value.trim()) return `${label} is required.`;
  }

  for (let i = 0; i < form.subjects.length; i++) {
    const sub = form.subjects[i];
    const at = `Subject ${i + 1}`;
    const code = sub.subjectCode.trim();
    if (!code) return `${at}: subject code is required.`;
    if (!SUBJECT_CODE_PATTERN.test(code)) {
      return `${at}: subject code must be alphanumeric (e.g. CS401).`;
    }
    if (!sub.subjectName.trim()) return `${at}: subject name is required.`;
    if (!isNumeric(sub.internalMarks) || num(sub.internalMarks) < 0) {
      return `${at}: internal marks must be 0 or more.`;
    }
    if (!isNumeric(sub.externalMarks) || num(sub.externalMarks) < 0) {
      return `${at}: external marks must be 0 or more.`;
    }
    if (!isNumeric(sub.maxMarks) || num(sub.maxMarks) <= 0) {
      return `${at}: maximum marks must be greater than 0.`;
    }
    if (subjectTotal(sub) > num(sub.maxMarks)) {
      return `${at}: internal + external marks cannot exceed the maximum marks.`;
    }
    if (!sub.grade.trim()) return `${at}: grade is required.`;
    if (!GRADE_PATTERN.test(sub.grade.trim())) {
      return `${at}: grade must be a letter grade (e.g. A, B+, F).`;
    }
    if (!isNumeric(sub.gradePoint) || num(sub.gradePoint) < 0) {
      return `${at}: grade point must be 0 or more.`;
    }
    if (!isNumeric(sub.credits) || !Number.isInteger(num(sub.credits)) || num(sub.credits) <= 0) {
      return `${at}: credits must be a positive whole number.`;
    }
  }

  const totals = calcResultTotals(form.subjects);
  if (totals.maxTotalMarks <= 0) {
    return "Maximum marks must be greater than 0 for at least one subject.";
  }
  if (totals.percentage > 100) {
    return "Total marks cannot exceed the maximum total marks.";
  }
  if (!form.cgpa.trim()) return "CGPA is required.";
  if (!form.resultStatus) return "Result status is required.";
  if (form.subjects.some((sub) => sub.isBacklog) && form.resultStatus !== "COMPARTMENT") {
    return "A subject is marked as compartment/backlog — set the result status to COMPARTMENT.";
  }
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

  const fetchResults = useCallback(async (page = 1) => {
    const token = getStoredToken(); if (!token) return;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: "20" });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/results?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { setError("Unable to load results."); return; }
      const data = await res.json();
      if (data.success) { setResults(data.data); setPagination(data.pagination); }
    } catch { setError("Unable to connect to server."); } finally { setLoading(false); }
  }, [search, statusFilter]);

  useEffect(() => { fetchResults(1); }, [fetchResults]);

  function handleSearch(e: React.FormEvent) { e.preventDefault(); fetchResults(1); }
  function formatDate(d: string) { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }

  function updateFormFields(setter: React.Dispatch<React.SetStateAction<FormState>>, field: keyof FormState, value: string | boolean) {
    setter((prev) => ({ ...prev, [field]: value }));
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
   * Flagging a subject drives the result status to COMPARTMENT (the admin can
   * still change it afterwards); clearing the last flag clears it again.
   */
  function toggleBacklog(index: number) {
    setCreateForm((prev) => {
      const subjects = prev.subjects.map((sub, i) =>
        i === index ? { ...sub, isBacklog: !sub.isBacklog } : sub
      );
      const anyBacklog = subjects.some((sub) => sub.isBacklog);
      let resultStatus = prev.resultStatus;
      if (anyBacklog && resultStatus !== "COMPARTMENT") resultStatus = "COMPARTMENT";
      else if (!anyBacklog && resultStatus === "COMPARTMENT") resultStatus = "";
      return { ...prev, subjects, resultStatus };
    });
  }

  /** Resize the dynamic subject list from the "Number of Subjects" input. */
  function setSubjectCount(value: string) {
    setCreateForm((prev) => ({
      ...prev,
      subjects: resizeSubjects(prev.subjects, Number(value)),
    }));
  }

  function buildRequestBody(form: FormState) {
    return {
      student: { name: form.studentName.trim(), rollNumber: form.rollNumber.trim(), enrollmentNumber: form.enrollmentNumber.trim(), course: form.course.trim(), semester: form.semester.trim(), academicSession: form.academicSession.trim(), collegeName: form.collegeName.trim() },
      subjects: form.subjects.map((sub) => ({ subjectCode: sub.subjectCode.trim(), subjectName: sub.subjectName.trim(), internalMarks: Number(sub.internalMarks), externalMarks: Number(sub.externalMarks), totalMarks: Number(sub.totalMarks), maxMarks: Number(sub.maxMarks), grade: sub.grade.trim(), gradePoint: Number(sub.gradePoint), credits: Number(sub.credits), isBacklog: sub.isBacklog })),
      totalMarks: Number(form.totalMarks), maxTotalMarks: Number(form.maxTotalMarks), percentage: Number(form.percentage), cgpa: form.cgpa.trim(), resultStatus: form.resultStatus, remarks: form.remarks.trim(), declaredDate: form.declaredDate.trim(),
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
          studentName: r.student.name, rollNumber: r.student.rollNumber, enrollmentNumber: r.student.enrollmentNumber,
          course: r.student.course, semester: r.student.semester, academicSession: r.student.academicSession || "", collegeName: r.student.collegeName || "",
          subjects: r.subjects.length > 0 ? r.subjects.map((s: Record<string, unknown>) => ({
            subjectCode: String(s.subjectCode), subjectName: String(s.subjectName), internalMarks: String(s.internalMarks), externalMarks: String(s.externalMarks),
            totalMarks: String(s.totalMarks), maxMarks: String(s.maxMarks), grade: String(s.grade), gradePoint: String(s.gradePoint), credits: String(s.credits), isBacklog: Boolean(s.isBacklog),
          })) : [blankSubject()],
          totalMarks: String(r.totalMarks), maxTotalMarks: String(r.maxTotalMarks), percentage: String(r.percentage),
          cgpa: r.cgpa, resultStatus: r.resultStatus, remarks: r.remarks || "", declaredDate: r.declaredDate,
        });
      }
    } catch { setEditError("Unable to connect to server."); }
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault(); if (editLoading || !editingResultId) return;
    setEditLoading(true); setEditError(""); setEditSuccess("");
    const token = getStoredToken(); if (!token) { setEditError("Not authenticated."); setEditLoading(false); return; }
    try {
      const res = await fetch("/api/admin/results", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ resultId: editingResultId, ...buildRequestBody(editForm) }) });
      const data = await res.json();
      if (!data.success) { setEditError(data.message || "Failed to update."); return; }
      setEditSuccess("Result updated!");
      setTimeout(() => { setShowEditForm(false); setEditingResultId(""); setEditSuccess(""); setEditForm(blankForm()); fetchResults(pagination.page); }, 1000);
    } catch { setEditError("Unable to connect to server."); } finally { setEditLoading(false); }
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

  // Derived for the Add Result summary — never stored in form state.
  const createTotals = calcResultTotals(createForm.subjects);
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
              {search && (<button type="button" className={styles.clearBtn} onClick={() => { setSearch(""); setTimeout(() => fetchResults(1), 0); }}><X size={14} /></button>)}
            </div>
            <Button type="submit" variant="primary" size="sm"><Search size={14} /> Search</Button>
          </form>
          <div className={styles.toolbarRight}>
            <div className={styles.filterRow}>
              <Filter size={14} />
              <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setTimeout(() => fetchResults(1), 0); }} className={styles.select}>
                <option value="">All Status</option>
                <option value="PASS">Pass</option>
                <option value="FAIL">Fail</option>
                <option value="COMPARTMENT">Compartment</option>
              </select>
            </div>
            <Button variant="primary" size="sm" onClick={() => { setCreateForm(blankForm()); setCreateError(""); setCreateSuccess(""); setShowCreateForm(true); }}><Plus size={14} /> Add Result</Button>
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
                <thead><tr><th>Student</th><th>Roll No</th><th>Course</th><th>Semester</th><th>Marks</th><th>CGPA</th><th>Status</th><th>Declared</th><th>Actions</th></tr></thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.id}>
                      <td className={styles.nameCell}>{r.student.name}</td>
                      <td className={styles.monoCell}>{r.student.rollNumber}</td>
                      <td>{r.student.course}</td>
                      <td>{r.student.semester}</td>
                      <td>{r.totalMarks}/{r.maxTotalMarks}</td>
                      <td className={styles.monoCell}>{r.cgpa}</td>
                      <td><Badge variant={getStatusVariant(r.resultStatus)}>{r.resultStatus}</Badge></td>
                      <td>{formatDate(r.declaredDate)}</td>
                      <td className={styles.actionsCell}>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setViewingResult(r)} title="View"><Eye size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openEditForm(r)} title="Edit"><Edit3 size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setDeletingResult(r)} title="Delete"><Trash2 size={15} /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

      {/* View Result Modal */}
      <Modal open={!!viewingResult} onClose={() => setViewingResult(null)}>
        {viewingResult && (
          <>
            <h3 className={styles.modalTitle}>Result Details</h3>
            <div className={styles.profileGrid}>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Student</span><span className={styles.profileValue}>{viewingResult.student.name}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Roll Number</span><span className={styles.profileValue}>{viewingResult.student.rollNumber}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Course</span><span className={styles.profileValue}>{viewingResult.student.course}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Semester</span><span className={styles.profileValue}>{viewingResult.student.semester}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Total Marks</span><span className={styles.profileValue}>{viewingResult.totalMarks} / {viewingResult.maxTotalMarks}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>CGPA</span><span className={styles.profileValue}>{viewingResult.cgpa}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Status</span><Badge variant={getStatusVariant(viewingResult.resultStatus)}>{viewingResult.resultStatus}</Badge></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Declared</span><span className={styles.profileValue}>{viewingResult.declaredDate}</span></div>
            </div>
            <div className={styles.modalActions}><Button variant="secondary" onClick={() => setViewingResult(null)}>Close</Button></div>
          </>
        )}
      </Modal>

      {/* Create Result Modal */}
      <Modal open={showCreateForm} onClose={() => { if (!createLoading) { setShowCreateForm(false); setCreateError(""); setCreateSuccess(""); } }} maxWidth={860}>
        <form onSubmit={handleCreateSubmit}>
          {/* Add Result form — student info, result info, dynamic subjects, summary */}
          <h3 className={styles.modalTitle}>Add New Result</h3>
          <p className={styles.modalDesc}>Enter student details and subject-wise marks. Subject totals, maximum marks and percentage are calculated automatically.</p>
          <ModalScrollable>
            {/* ── Student Information ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Student Information</h4>
              <div className={styles.formGrid}>
                <div className={styles.formField}><label>Student Name *</label><input type="text" placeholder="e.g. Aarav Sharma" value={createForm.studentName} onChange={(e) => updateFormFields(setCreateForm, "studentName", e.target.value)} /></div>
                <div className={styles.formField}><label>Roll Number *</label><input type="text" placeholder="e.g. MSU2024001" value={createForm.rollNumber} onChange={(e) => updateFormFields(setCreateForm, "rollNumber", e.target.value)} /></div>
                <div className={styles.formField}><label>Enrollment Number *</label><input type="text" placeholder="e.g. EN2024CS1001" value={createForm.enrollmentNumber} onChange={(e) => updateFormFields(setCreateForm, "enrollmentNumber", e.target.value)} /></div>
                <div className={styles.formField}><label>Course *</label><input type="text" placeholder="e.g. B.Sc Computer Science" value={createForm.course} onChange={(e) => updateFormFields(setCreateForm, "course", e.target.value)} /></div>
                <div className={styles.formField}><label>Semester *</label><input type="text" placeholder="e.g. Semester IV" value={createForm.semester} onChange={(e) => updateFormFields(setCreateForm, "semester", e.target.value)} /></div>
                <div className={styles.formField}><label>Academic Session *</label><input type="text" placeholder="e.g. 2025-2026" value={createForm.academicSession} onChange={(e) => updateFormFields(setCreateForm, "academicSession", e.target.value)} /></div>
                <div className={styles.formField}><label>College Name *</label><input type="text" placeholder="e.g. University College" value={createForm.collegeName} onChange={(e) => updateFormFields(setCreateForm, "collegeName", e.target.value)} /></div>
              </div>
            </section>

            {/* ── Result Information ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Result Information</h4>
              <div className={styles.formGrid}>
                <div className={styles.formField}><label>Number of Subjects *</label><input type="number" min={1} max={MAX_SUBJECTS} value={createForm.subjects.length} onChange={(e) => setSubjectCount(e.target.value)} /></div>
                <div className={styles.formField}><label>Declared Date *</label><input type="text" placeholder="15 July 2026" value={createForm.declaredDate} onChange={(e) => updateFormFields(setCreateForm, "declaredDate", e.target.value)} /></div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}><label>Remarks</label><input type="text" placeholder="Optional" value={createForm.remarks} onChange={(e) => updateFormFields(setCreateForm, "remarks", e.target.value)} /></div>
              </div>
            </section>

            {/* ── Subjects ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Subjects ({createForm.subjects.length})</h4>
              <div className={styles.subjectList}>
                {createForm.subjects.map((sub, i) => (
                  <div key={i} className={`${styles.subjectCard} ${sub.isBacklog ? styles.subjectCardBacklog : ""}`}>
                    <div className={styles.subjectCardHeader}>
                      <span className={styles.subjectCardTitle}>Subject {i + 1}</span>
                      {sub.isBacklog && <Badge variant="warning">Compartment</Badge>}
                    </div>
                    <div className={styles.formGrid}>
                      <div className={styles.formField}><label>Subject Code *</label><input type="text" placeholder="e.g. CS401" value={sub.subjectCode} onChange={(e) => updateSubject(i, "subjectCode", e.target.value)} /></div>
                      <div className={styles.formField}><label>Subject Name *</label><input type="text" placeholder="e.g. Data Structures & Algorithms" value={sub.subjectName} onChange={(e) => updateSubject(i, "subjectName", e.target.value)} /></div>
                      <div className={styles.formField}><label>Internal Marks *</label><input type="number" min={0} placeholder="28" value={sub.internalMarks} onChange={(e) => updateSubject(i, "internalMarks", e.target.value)} /></div>
                      <div className={styles.formField}><label>External Marks *</label><input type="number" min={0} placeholder="58" value={sub.externalMarks} onChange={(e) => updateSubject(i, "externalMarks", e.target.value)} /></div>
                      <div className={`${styles.formField} ${styles.autoField}`}><label>Total Marks (auto)</label><input type="number" value={subjectTotal(sub)} readOnly tabIndex={-1} /></div>
                      <div className={styles.formField}><label>Maximum Marks *</label><input type="number" min={1} placeholder="100" value={sub.maxMarks} onChange={(e) => updateSubject(i, "maxMarks", e.target.value)} /></div>
                      <div className={styles.formField}><label>Grade *</label><input type="text" placeholder="e.g. A" value={sub.grade} onChange={(e) => updateSubject(i, "grade", e.target.value)} /></div>
                      <div className={styles.formField}><label>Grade Point *</label><input type="number" min={0} step="0.1" placeholder="9" value={sub.gradePoint} onChange={(e) => updateSubject(i, "gradePoint", e.target.value)} /></div>
                      <div className={styles.formField}><label>Credits *</label><input type="number" min={1} step={1} placeholder="4" value={sub.credits} onChange={(e) => updateSubject(i, "credits", e.target.value)} /></div>
                    </div>
                    <label className={styles.checkRow}>
                      <input type="checkbox" checked={sub.isBacklog} onChange={() => toggleBacklog(i)} />
                      <span>Compartment / Backlog — this subject is a compartment subject for this student</span>
                    </label>
                  </div>
                ))}
              </div>
            </section>

            {/* ── Result Summary ── */}
            <section className={styles.formSection}>
              <h4 className={styles.formSectionTitle}>Result Summary</h4>
              <div className={styles.summaryGrid}>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>Total Marks</span><span className={styles.summaryValue}>{createTotals.totalMarks}</span></div>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>Maximum Marks</span><span className={styles.summaryValue}>{createTotals.maxTotalMarks}</span></div>
                <div className={styles.summaryItem}><span className={styles.summaryLabel}>Percentage</span><span className={styles.summaryValue}>{createTotals.percentage.toFixed(2)}%</span></div>
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formField}><label>CGPA *</label><input type="text" placeholder="8.20" value={createForm.cgpa} onChange={(e) => updateFormFields(setCreateForm, "cgpa", e.target.value)} /></div>
                <div className={styles.formField}>
                  <label>Result Status *</label>
                  <select value={createForm.resultStatus} onChange={(e) => updateFormFields(setCreateForm, "resultStatus", e.target.value)}><option value="">Select</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="COMPARTMENT">COMPARTMENT</option></select>
                  {hasBacklogSubjects && createForm.resultStatus === "COMPARTMENT" && (<span className={styles.fieldHint}>Set automatically because a subject is marked as compartment.</span>)}
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
              <div className={styles.formField}><label>CGPA *</label><input type="text" value={editForm.cgpa} onChange={(e) => updateFormFields(setEditForm, "cgpa", e.target.value)} /></div>
              <div className={styles.formField}><label>Result Status *</label><select value={editForm.resultStatus} onChange={(e) => updateFormFields(setEditForm, "resultStatus", e.target.value)}><option value="">Select</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="COMPARTMENT">COMPARTMENT</option></select></div>
              <div className={styles.formField}><label>Declared Date *</label><input type="text" value={editForm.declaredDate} onChange={(e) => updateFormFields(setEditForm, "declaredDate", e.target.value)} /></div>
              <div className={styles.formField}><label>Total Marks</label><input type="number" min="0" value={editForm.totalMarks} onChange={(e) => updateFormFields(setEditForm, "totalMarks", e.target.value)} /></div>
              <div className={styles.formField}><label>Max Total Marks</label><input type="number" min="1" value={editForm.maxTotalMarks} onChange={(e) => updateFormFields(setEditForm, "maxTotalMarks", e.target.value)} /></div>
              <div className={styles.formField}><label>Percentage</label><input type="number" min="0" max="100" step="0.1" value={editForm.percentage} onChange={(e) => updateFormFields(setEditForm, "percentage", e.target.value)} /></div>
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
