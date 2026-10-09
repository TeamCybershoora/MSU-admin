"use client";

/**
 * Student Management Page — CRUD + Phase 4 application review.
 *
 * Features:
 * - Paginated table with search (name, email, username), course filter,
 *   account-status filter and Phase 4 application-status filter
 * - View student profile in a modal (read-only)
 * - Edit student fields (name, course, college, phone) — identity fields
 *   (email, aadhar, abcId) are intentionally NOT editable
 * - Application review: request structured corrections, reject with a reason,
 *   or verify a pending application. Review history and the current correction
 *   request are shown read-only.
 * - Phase 5 enrollment: enroll an eligible verified student. The identifiers
 *   are generated server-side and are displayed read-only — the UI never sends
 *   or edits an official identifier.
 *
 * Data flow:
 *   1. GET  /api/admin/students        — list + filters
 *   2. PUT  /api/admin/students        — update a single student by ID
 *   3. PATCH/DELETE /api/admin/students — account status / hard delete
 *   4. POST /api/admin/students/[id]/review — Phase 4 review action
 *   5. POST /api/admin/students/[id]/enroll — Phase 5 enrollment (no body)
 *   All requests include the JWT via the Authorization header.
 *
 * Security:
 * - Every endpoint is protected server-side (authenticateAdmin); the UI never
 *   decides authorization and never displays passwords or credentials.
 * - Client-side checks are convenience only — the server re-validates and
 *   enforces the permitted status transitions atomically.
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/lib/student-review (correction field allowlist + labels + limits)
 *   - @/components/ui/* (Card, Button, Badge, Modal)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Search,
  Filter,
  Edit3,
  Eye,
  ChevronLeft,
  ChevronRight,
  Users,
  X,
  Power,
  Trash2,
  ClipboardCheck,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  History,
  RotateCcw,
  UserCheck,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import {
  CORRECTION_FIELDS,
  CORRECTION_FIELD_LABELS,
  MAX_ADDITIONAL_INSTRUCTIONS_LENGTH,
  MAX_FIELD_NOTE_LENGTH,
  MAX_REJECTION_REASON_LENGTH,
  REVIEW_ACTION_LABELS,
  type CorrectionField,
} from "@/lib/student-review";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import SearchableSelect from "@/components/ui/searchable-select";
import Modal, { ConfirmDialog, ModalScrollable } from "@/components/ui/modal";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

type AccountStatusValue = "ACTIVE" | "INACTIVE";
type ApplicationStatus =
  | "pending"
  | "needs_correction"
  | "verified"
  | "rejected"
  | "enrolled";

interface CorrectionFieldEntry {
  field: CorrectionField;
  note: string;
}

interface CorrectionRequestRecord {
  fields: CorrectionFieldEntry[];
  additionalInstructions: string;
  requestedAt: string | null;
  requestedById: string;
  requestedByRole: string;
}

interface ReviewHistoryRecord {
  action: "request_correction" | "reject" | "verify";
  fromStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  reason: string;
  fields: CorrectionFieldEntry[];
  additionalInstructions: string;
  actorId: string;
  actorRole: string;
  at: string;
}

interface Student {
  id: string;
  name: string;
  email: string;
  username: string;
  course: string;
  college: string;
  phone: string;
  aadhar?: string;
  abcId?: string;
  gender?: string | null;
  fatherName?: string | null;
  motherName?: string | null;
  admissionYear?: number | null;
  status: AccountStatusValue;
  applicationStatus: ApplicationStatus;
  accountStatus: string;
  rejectionReason?: string | null;
  correctionMessage?: string | null;
  correctionRequest?: CorrectionRequestRecord | null;
  reviewHistory?: ReviewHistoryRecord[];
  verifiedAt?: string | null;
  enrolledAt?: string | null;
  enrollmentNumber?: string | null;
  universityRollNumber?: string | null;
  /** Server-computed convenience flag; the enrollment API re-checks it. */
  enrollmentEligible?: boolean;
  registeredAt: string;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface Filters {
  courses: string[];
}

const APPLICATION_STATUS_OPTIONS: { value: ApplicationStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "needs_correction", label: "Needs Correction" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "enrolled", label: "Enrolled" },
];

function humanizeStatus(value?: string): string {
  if (!value) return "Unknown";
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function applicationStatusVariant(
  status: ApplicationStatus
): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "verified":
    case "enrolled":
      return "success";
    case "rejected":
      return "danger";
    case "needs_correction":
      return "warning";
    case "pending":
      return "info";
    default:
      return "neutral";
  }
}

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ReviewAction = "request_correction" | "reject" | "verify";

export default function AdminStudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [filters, setFilters] = useState<Filters>({ courses: [] });
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [appStatusFilter, setAppStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Activate / deactivate confirmation.
  const [statusTarget, setStatusTarget] = useState<Student | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Permanent (hard) delete confirmation — requires retyping the email.
  const [deletingStudent, setDeletingStudent] = useState<Student | null>(null);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [editForm, setEditForm] = useState({ name: "", course: "", college: "", phone: "" });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [editSuccess, setEditSuccess] = useState("");

  const [viewingStudent, setViewingStudent] = useState<Student | null>(null);

  // ── Phase 4 review state ──────────────────────────────────────────────
  const [reviewingStudent, setReviewingStudent] = useState<Student | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [correctionSelected, setCorrectionSelected] = useState<Record<string, boolean>>({});
  const [correctionNotes, setCorrectionNotes] = useState<Record<string, string>>({});
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewSuccess, setReviewSuccess] = useState("");

  // ── Phase 5 enrollment state ──────────────────────────────────────────
  const [enrollingStudent, setEnrollingStudent] = useState<Student | null>(null);
  const [enrollConfirmed, setEnrollConfirmed] = useState(false);
  const [enrollLoading, setEnrollLoading] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const [enrollSuccess, setEnrollSuccess] = useState("");
  const [enrollResult, setEnrollResult] = useState<{
    alreadyEnrolled: boolean;
    enrollmentNumber: string;
    universityRollNumber: string;
  } | null>(null);

  // Monotonic request id. Only the newest request is allowed to write state,
  // so a slow earlier response can never overwrite a newer (filtered) one.
  const requestSeq = useRef(0);

  const fetchStudents = useCallback(async (page = 1) => {
    const token = getStoredToken();
    if (!token) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({ page: page.toString(), limit: "20" });
      if (search) params.set("search", search);
      if (courseFilter) params.set("course", courseFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (appStatusFilter) params.set("applicationStatus", appStatusFilter);

      const res = await fetch(`/api/admin/students?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (seq !== requestSeq.current) return;
      if (!res.ok) { setError("Unable to load students."); return; }

      const data = await res.json();
      if (seq !== requestSeq.current) return;
      if (data.success) {
        setStudents(data.data);
        setPagination(data.pagination);
        setFilters(data.filters);
      }
    } catch {
      if (seq === requestSeq.current) setError("Unable to connect to server.");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [search, courseFilter, statusFilter, appStatusFilter]);

  // Single source of refetch: this callback's identity changes with every
  // filter/search value, so the effect below refetches with the NEW values.
  // Filter handlers must NOT refetch themselves — an immediate call there
  // would run a stale closure and race this request, letting the stale
  // (unfiltered) response land last and show the previous filter's rows.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchStudents(1); }, [fetchStudents]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchStudents(1);
  }

  function openEdit(student: Student) {
    setEditingStudent(student);
    setEditForm({ name: student.name, course: student.course, college: student.college, phone: student.phone });
    setEditError("");
    setEditSuccess("");
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingStudent || editLoading) return;
    setEditLoading(true);
    setEditError("");
    setEditSuccess("");

    const token = getStoredToken();
    if (!token) return;

    try {
      const res = await fetch("/api/admin/students", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ studentId: editingStudent.id, ...editForm }),
      });

      const data = await res.json();
      if (!data.success) { setEditError(data.message || "Update failed."); return; }

      setEditSuccess("Student updated successfully!");
      setStudents((prev) => prev.map((s) => s.id === editingStudent.id ? { ...s, ...editForm } : s));
      setTimeout(() => { setEditingStudent(null); setEditSuccess(""); }, 1500);
    } catch {
      setEditError("Unable to connect to server.");
    } finally {
      setEditLoading(false);
    }
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  function statusVariant(status: AccountStatusValue): "success" | "neutral" {
    return status === "ACTIVE" ? "success" : "neutral";
  }

  function openStatusToggle(student: Student) {
    setStatusTarget(student);
  }

  /**
   * Activate or deactivate a student. The server is authoritative; the list is
   * refetched on success so no stale row is left behind. Failures surface on
   * the page (the same pattern as Admin status toggling) and never remove the
   * row locally.
   */
  async function handleStatusToggle() {
    if (!statusTarget || statusLoading) return;

    const token = getStoredToken();
    if (!token) return;

    const nextStatus: AccountStatusValue = statusTarget.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";

    setStatusLoading(true);
    try {
      const res = await fetch("/api/admin/students", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ studentId: statusTarget.id, status: nextStatus }),
      });
      const data = await res.json();
      if (data.success) fetchStudents(pagination.page);
      else setError(data.message || "Unable to update student status.");
    } catch {
      setError("Unable to connect to server.");
    } finally {
      setStatusLoading(false);
      setStatusTarget(null);
    }
  }

  function openDelete(student: Student) {
    setDeletingStudent(student);
    setDeleteConfirmEmail("");
    setDeleteError("");
  }

  /**
   * Permanently delete the student. The typed email is sent to the server, which
   * validates it before deleting; a failure keeps the row in place.
   */
  async function handleDelete() {
    if (!deletingStudent || deleteLoading) return;
    setDeleteLoading(true);
    setDeleteError("");

    const token = getStoredToken();
    if (!token) { setDeleteError("Not authenticated."); setDeleteLoading(false); return; }

    try {
      const res = await fetch("/api/admin/students", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ studentId: deletingStudent.id, confirmEmail: deleteConfirmEmail }),
      });
      const data = await res.json();
      if (!data.success) { setDeleteError(data.message || "Delete failed."); return; }

      setDeletingStudent(null);
      fetchStudents(pagination.page);
    } catch {
      setDeleteError("Unable to connect to server.");
    } finally {
      setDeleteLoading(false);
    }
  }

  /* ── Phase 4 review handlers ────────────────────────────────────────── */

  function resetReviewForm() {
    setReviewAction(null);
    setCorrectionSelected({});
    setCorrectionNotes({});
    setAdditionalInstructions("");
    setRejectReason("");
    setReviewError("");
    setReviewSuccess("");
  }

  function openReview(student: Student) {
    resetReviewForm();
    setReviewingStudent(student);
  }

  function closeReview() {
    if (reviewLoading) return;
    setReviewingStudent(null);
    resetReviewForm();
  }

  function selectedCorrectionFields(): CorrectionFieldEntry[] {
    return CORRECTION_FIELDS.filter((field) => correctionSelected[field]).map((field) => ({
      field,
      note: (correctionNotes[field] ?? "").trim(),
    }));
  }

  async function handleReviewSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reviewingStudent || reviewLoading || !reviewAction) return;

    setReviewError("");
    setReviewSuccess("");

    const body: Record<string, unknown> = { action: reviewAction };

    if (reviewAction === "request_correction") {
      const fields = selectedCorrectionFields();
      const instructions = additionalInstructions.trim();
      if (fields.length === 0 && !instructions) {
        setReviewError("Select at least one field or provide additional instructions.");
        return;
      }
      body.fields = fields;
      body.additionalInstructions = instructions;
    } else if (reviewAction === "reject") {
      if (!rejectReason.trim()) {
        setReviewError("A rejection reason is required.");
        return;
      }
      body.reason = rejectReason.trim();
    }

    setReviewLoading(true);
    try {
      const token = getStoredToken();
      if (!token) { setReviewError("Not authenticated."); return; }

      const res = await fetch(`/api/admin/students/${reviewingStudent.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!data.success) {
        setReviewError(data.message || "Review action failed.");
        return;
      }

      const updated = data.student as Student;
      setStudents((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      // Show the persisted result (status + assigned identifiers) in the modal.
      setReviewingStudent(updated);
      setReviewSuccess(data.message || "Review action applied.");
      setReviewAction(null);
      // Refetch so the active application-status filter stays accurate.
      fetchStudents(pagination.page);
      // Verification also assigns the official identifiers, so the modal stays
      // open until the reviewer acknowledges it — otherwise the confirmation
      // (and the newly persisted numbers) would vanish after a moment.
      if (reviewAction !== "verify") {
        setTimeout(() => {
          setReviewingStudent(null);
          resetReviewForm();
        }, 1200);
      }
    } catch {
      setReviewError("Unable to connect to server.");
    } finally {
      setReviewLoading(false);
    }
  }

  /* ── Phase 5 enrollment handlers ─────────────────────────────────────── */

  function openEnroll(student: Student) {
    setEnrollingStudent(student);
    setEnrollConfirmed(false);
    setEnrollError("");
    setEnrollSuccess("");
    setEnrollResult(null);
  }

  function closeEnroll() {
    if (enrollLoading) return;
    setEnrollingStudent(null);
    setEnrollConfirmed(false);
    setEnrollError("");
    setEnrollSuccess("");
    setEnrollResult(null);
  }

  /**
   * Enroll the student. The request body is intentionally empty: the server
   * allocates and formats the identifiers, derives the reviewer identity from
   * the authenticated session and uses its own timestamp. Every restriction is
   * enforced server-side — the confirmation checkbox only prevents an
   * accidental click.
   */
  async function handleEnroll() {
    if (!enrollingStudent || enrollLoading || !enrollConfirmed) return;
    setEnrollLoading(true);
    setEnrollError("");
    setEnrollSuccess("");

    const token = getStoredToken();
    if (!token) {
      setEnrollError("Not authenticated.");
      setEnrollLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/admin/students/${enrollingStudent.id}/enroll`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      if (!data.success) {
        setEnrollError(data.message || "Enrollment failed.");
        // The record may have changed elsewhere (concurrent review/enrollment).
        fetchStudents(pagination.page);
        return;
      }

      const updated = data.student as Student;
      setStudents((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEnrollResult({
        alreadyEnrolled: !!data.alreadyEnrolled,
        enrollmentNumber: updated.enrollmentNumber ?? "",
        universityRollNumber: updated.universityRollNumber ?? "",
      });
      setEnrollSuccess(data.message || "Student enrolled.");
      // Refetch so the active application-status filter stays accurate.
      fetchStudents(pagination.page);
    } catch {
      setEnrollError("Unable to connect to server.");
    } finally {
      setEnrollLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input type="text" placeholder="Search by name, email, phone, or username..." value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (<button type="button" className={styles.clearBtn} onClick={() => { setSearch(""); }}><X size={14} /></button>)}
            </div>
            <Button type="submit" variant="primary" size="sm"><Search size={14} /> Search</Button>
          </form>
          <div className={styles.filterRow}>
            <Filter size={14} />
            <SearchableSelect
              id="students-course-filter"
              variant="compact"
              label="Filter by course"
              placeholder="All Courses"
              value={courseFilter}
              options={[
                { value: "", label: "All Courses" },
                ...filters.courses.map((c) => ({ value: c, label: c })),
              ]}
              triggerClassName={styles.select}
              onChange={(value) => {
                setCourseFilter(value);
              }}
            />
            <SearchableSelect
              id="students-app-status-filter"
              variant="compact"
              label="Filter by application status"
              placeholder="All Application Status"
              value={appStatusFilter}
              options={[
                { value: "", label: "All Application Status" },
                ...APPLICATION_STATUS_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                })),
              ]}
              triggerClassName={styles.select}
              onChange={(value) => {
                setAppStatusFilter(value);
              }}
            />
            <SearchableSelect
              id="students-status-filter"
              variant="compact"
              label="Filter by account status"
              placeholder="All Account Status"
              value={statusFilter}
              options={[
                { value: "", label: "All Account Status" },
                { value: "ACTIVE", label: "Active" },
                { value: "INACTIVE", label: "Inactive" },
              ]}
              triggerClassName={styles.select}
              onChange={(value) => {
                setStatusFilter(value);
              }}
            />
          </div>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader title={`Students (${pagination.total})`} subtitle={`Page ${pagination.page} of ${pagination.totalPages || 1}`} />

        {loading ? (
          <div className={styles.loadingState}><div className={styles.spinner} /><p>Loading students...</p></div>
        ) : error ? (
          <ErrorState title="Unable to load students" description={error} onRetry={() => fetchStudents(pagination.page)} />
        ) : students.length === 0 ? (
          <EmptyState icon={<Users />} title="No students found" description="No students match your search criteria." />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead><tr><th>Name</th><th>Email</th><th>Course</th><th>College</th><th>Identifiers</th><th>Application</th><th>Account</th><th>Registered</th><th>Actions</th></tr></thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.id}>
                      <td className={styles.nameCell}>{student.name}</td>
                      <td className={styles.emailCell}>{student.email}</td>
                      <td>{student.course}</td>
                      <td className={styles.collegeCell}>{student.college}</td>
                      <td className={styles.monoCell}>
                        {student.enrollmentNumber || student.universityRollNumber ? (
                          <>
                            {student.enrollmentNumber || "—"}
                            <br />
                            {student.universityRollNumber || "—"}
                          </>
                        ) : (
                          <span className={styles.emailCell}>Not assigned</span>
                        )}
                      </td>
                      <td>
                        <Badge variant={applicationStatusVariant(student.applicationStatus)}>
                          {humanizeStatus(student.applicationStatus)}
                        </Badge>
                      </td>
                      <td><Badge variant={statusVariant(student.status)}>{student.status === "ACTIVE" ? "Active" : "Inactive"}</Badge></td>
                      <td>{formatDate(student.registeredAt)}</td>
                      <td className={styles.actionsCell}>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openReview(student)} title="Review application" aria-label={`Review application of ${student.name}`}><ClipboardCheck size={15} /></Button>
                        {student.enrollmentEligible && (<Button variant="ghost" size="sm" iconOnly onClick={() => openEnroll(student)} title="Assign official identifiers" aria-label={`Assign official identifiers for ${student.name}`}><UserCheck size={15} /></Button>)}
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setViewingStudent(student)} title="View profile" aria-label={`View profile of ${student.name}`}><Eye size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openEdit(student)} title="Edit student" aria-label={`Edit ${student.name}`}><Edit3 size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openStatusToggle(student)} title={student.status === "ACTIVE" ? "Deactivate" : "Activate"} aria-label={`${student.status === "ACTIVE" ? "Deactivate" : "Activate"} ${student.name}`}><Power size={15} /></Button>
                        <Button variant="danger" size="sm" iconOnly onClick={() => openDelete(student)} title="Delete permanently" aria-label={`Delete ${student.name} permanently`}><Trash2 size={15} /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile only (<=600px): same students array as the table above,
                rendered as record cards. Hidden on desktop/tablet. */}
            <RecordList>
              {students.map((student) => (
                <RecordCard
                  key={student.id}
                  title={student.name}
                  subtitle={student.email}
                  actions={
                    <>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openReview(student)} title="Review application" aria-label={`Review application of ${student.name}`}><ClipboardCheck size={15} /></Button>
                      {student.enrollmentEligible && (<Button variant="ghost" size="sm" iconOnly onClick={() => openEnroll(student)} title="Assign official identifiers" aria-label={`Assign official identifiers for ${student.name}`}><UserCheck size={15} /></Button>)}
                      <Button variant="ghost" size="sm" iconOnly onClick={() => setViewingStudent(student)} title="View profile" aria-label={`View profile of ${student.name}`}><Eye size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openEdit(student)} title="Edit student" aria-label={`Edit ${student.name}`}><Edit3 size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openStatusToggle(student)} title={student.status === "ACTIVE" ? "Deactivate" : "Activate"} aria-label={`${student.status === "ACTIVE" ? "Deactivate" : "Activate"} ${student.name}`}><Power size={15} /></Button>
                      <Button variant="danger" size="sm" iconOnly onClick={() => openDelete(student)} title="Delete permanently" aria-label={`Delete ${student.name} permanently`}><Trash2 size={15} /></Button>
                    </>
                  }
                >
                  <RecordField label="Course">{student.course}</RecordField>
                  <RecordField label="College">{student.college}</RecordField>
                  <RecordField label="Enrollment no.">{student.enrollmentNumber || "Not assigned"}</RecordField>
                  <RecordField label="University roll no.">{student.universityRollNumber || "Not assigned"}</RecordField>
                  <RecordField label="Application"><Badge variant={applicationStatusVariant(student.applicationStatus)}>{humanizeStatus(student.applicationStatus)}</Badge></RecordField>
                  <RecordField label="Account"><Badge variant={statusVariant(student.status)}>{student.status === "ACTIVE" ? "Active" : "Inactive"}</Badge></RecordField>
                  <RecordField label="Registered">{formatDate(student.registeredAt)}</RecordField>
                </RecordCard>
              ))}
            </RecordList>

            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button variant="secondary" size="sm" disabled={pagination.page <= 1} onClick={() => fetchStudents(pagination.page - 1)}><ChevronLeft size={14} /> Previous</Button>
                <span className={styles.pageInfo}>Page {pagination.page} of {pagination.totalPages}</span>
                <Button variant="secondary" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchStudents(pagination.page + 1)}>Next <ChevronRight size={14} /></Button>
              </div>
            )}
          </>
        )}
      </Card>

      <Modal open={!!viewingStudent} onClose={() => setViewingStudent(null)}>
        {viewingStudent && (
          <>
            <h3 className={styles.modalTitle}>Student Profile</h3>
            <div className={styles.profileGrid}>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Name</span><span className={styles.profileValue}>{viewingStudent.name}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Email</span><span className={styles.profileValue}>{viewingStudent.email}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Username</span><span className={styles.profileValue}>{viewingStudent.username}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Course</span><span className={styles.profileValue}>{viewingStudent.course}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>College</span><span className={styles.profileValue}>{viewingStudent.college}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Phone</span><span className={styles.profileValue}>{viewingStudent.phone}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Registered</span><span className={styles.profileValue}>{formatDate(viewingStudent.registeredAt)}</span></div>
            </div>
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setViewingStudent(null)}>Close</Button>
              <Button variant="primary" onClick={() => { setViewingStudent(null); openEdit(viewingStudent); }}><Edit3 size={14} /> Edit</Button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!editingStudent} onClose={() => { if (!editLoading) { setEditingStudent(null); setEditError(""); setEditSuccess(""); } }}>
        {editingStudent && (
          <form onSubmit={handleEditSubmit}>
            <h3 className={styles.modalTitle}>Edit Student</h3>
            <p className={styles.modalDesc}>Update student information. Identity fields cannot be changed.</p>
            <div className={styles.formFields}>
              <div className={styles.formField}><label>Name</label><input type="text" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} required /></div>
              <div className={styles.formField}><label>Course</label><input type="text" value={editForm.course} onChange={(e) => setEditForm((f) => ({ ...f, course: e.target.value }))} required /></div>
              <div className={styles.formField}><label>College</label><input type="text" value={editForm.college} onChange={(e) => setEditForm((f) => ({ ...f, college: e.target.value }))} required /></div>
              <div className={styles.formField}><label>Phone</label><input type="text" value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} maxLength={10} required /></div>
            </div>
            {editError && <p className={styles.formError}>{editError}</p>}
            {editSuccess && <p className={styles.formSuccess}>{editSuccess}</p>}
            <div className={styles.modalActions}>
              <Button type="button" variant="secondary" onClick={() => { setEditingStudent(null); setEditError(""); setEditSuccess(""); }} disabled={editLoading}>Cancel</Button>
              <Button type="submit" variant="primary" loading={editLoading}>Save Changes</Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Phase 4: application review ───────────────────────────────── */}
      <Modal open={!!reviewingStudent} onClose={closeReview} maxWidth={760}>
        {reviewingStudent && (
          <form onSubmit={handleReviewSubmit}>
            <h3 className={styles.modalTitle}>Review Application</h3>
            <p className={styles.modalDesc}>
              {reviewingStudent.name} · {reviewingStudent.email}
            </p>

            <ModalScrollable>
              <div className={styles.reviewStatusRow}>
                <span className={styles.profileLabel}>Application status</span>
                <Badge variant={applicationStatusVariant(reviewingStudent.applicationStatus)}>
                  {humanizeStatus(reviewingStudent.applicationStatus)}
                </Badge>
                <span className={styles.profileLabel}>Account status</span>
                <Badge variant={statusVariant(reviewingStudent.status)}>
                  {humanizeStatus(reviewingStudent.accountStatus)}
                </Badge>
              </div>

              <h4 className={styles.reviewSectionTitle}>Registration details</h4>
              <div className={styles.profileGrid}>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Name</span><span className={styles.profileValue}>{reviewingStudent.name}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Course</span><span className={styles.profileValue}>{reviewingStudent.course}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Father&apos;s name</span><span className={styles.profileValue}>{reviewingStudent.fatherName || "—"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Mother&apos;s name</span><span className={styles.profileValue}>{reviewingStudent.motherName || "—"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Gender</span><span className={styles.profileValue}>{reviewingStudent.gender || "—"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Admission year</span><span className={styles.profileValue}>{reviewingStudent.admissionYear ?? "—"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>College</span><span className={styles.profileValue}>{reviewingStudent.college}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Phone</span><span className={styles.profileValue}>{reviewingStudent.phone}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Aadhar</span><span className={styles.profileValue}>{reviewingStudent.aadhar || "—"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>ABC ID</span><span className={styles.profileValue}>{reviewingStudent.abcId || "—"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Verified at</span><span className={styles.profileValue}>{formatDateTime(reviewingStudent.verifiedAt)}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Enrollment no.</span><span className={styles.profileValue}>{reviewingStudent.enrollmentNumber || "Not assigned"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>University roll no.</span><span className={styles.profileValue}>{reviewingStudent.universityRollNumber || "Not assigned"}</span></div>
              </div>

              {/* Current correction request / legacy plain-text note */}
              {reviewingStudent.correctionRequest && (
                <div className={styles.reviewPanel}>
                  <h4 className={styles.reviewSectionTitle}><AlertTriangle size={14} /> Current correction request</h4>
                  {reviewingStudent.correctionRequest.fields.length > 0 && (
                    <ul className={styles.reviewList}>
                      {reviewingStudent.correctionRequest.fields.map((entry) => (
                        <li key={entry.field}>
                          <strong>{CORRECTION_FIELD_LABELS[entry.field] ?? entry.field}</strong>
                          {entry.note ? ` — ${entry.note}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {reviewingStudent.correctionRequest.additionalInstructions && (
                    <p className={styles.reviewNote}>{reviewingStudent.correctionRequest.additionalInstructions}</p>
                  )}
                  <p className={styles.reviewMeta}>
                    Requested {formatDateTime(reviewingStudent.correctionRequest.requestedAt)}
                  </p>
                </div>
              )}
              {!reviewingStudent.correctionRequest && reviewingStudent.correctionMessage && (
                <div className={styles.reviewPanel}>
                  <h4 className={styles.reviewSectionTitle}><AlertTriangle size={14} /> Correction note</h4>
                  <p className={styles.reviewNote}>{reviewingStudent.correctionMessage}</p>
                </div>
              )}

              {reviewingStudent.rejectionReason && (
                <div className={styles.reviewPanel}>
                  <h4 className={styles.reviewSectionTitle}><AlertTriangle size={14} /> Rejection reason</h4>
                  <p className={styles.reviewNote}>{reviewingStudent.rejectionReason}</p>
                </div>
              )}

              {/* Review history */}
              <h4 className={styles.reviewSectionTitle}><History size={14} /> Review history</h4>
              {(reviewingStudent.reviewHistory ?? []).length === 0 ? (
                <p className={styles.reviewMeta}>No review actions recorded yet.</p>
              ) : (
                <ul className={styles.historyList}>
                  {[...(reviewingStudent.reviewHistory ?? [])].reverse().map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className={styles.historyItem}>
                      <div className={styles.historyHead}>
                        <strong>{REVIEW_ACTION_LABELS[entry.action] ?? humanizeStatus(entry.action)}</strong>
                        <span className={styles.reviewMeta}>{formatDateTime(entry.at)}</span>
                      </div>
                      <p className={styles.reviewMeta}>
                        {humanizeStatus(entry.fromStatus)} → {humanizeStatus(entry.toStatus)} · {entry.actorRole}
                      </p>
                      {entry.reason && <p className={styles.reviewNote}>{entry.reason}</p>}
                      {entry.fields.length > 0 && (
                        <ul className={styles.reviewList}>
                          {entry.fields.map((field) => (
                            <li key={field.field}>
                              <strong>{CORRECTION_FIELD_LABELS[field.field] ?? field.field}</strong>
                              {field.note ? ` — ${field.note}` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                      {entry.additionalInstructions && <p className={styles.reviewNote}>{entry.additionalInstructions}</p>}
                    </li>
                  ))}
                </ul>
              )}

              {/* Action selection */}
              <h4 className={styles.reviewSectionTitle}><ShieldCheck size={14} /> Review action</h4>
              {reviewingStudent.applicationStatus !== "pending" ? (
                <p className={styles.reviewMeta}>
                  No review action is available while the application is &quot;{humanizeStatus(reviewingStudent.applicationStatus)}&quot;.
                </p>
              ) : (
                <>
                  <div className={styles.actionRow}>
                    <Button type="button" variant={reviewAction === "request_correction" ? "primary" : "secondary"} size="sm" onClick={() => { setReviewAction("request_correction"); setReviewError(""); }} disabled={reviewLoading}>
                      <RotateCcw size={14} /> Request correction
                    </Button>
                    <Button type="button" variant={reviewAction === "reject" ? "danger" : "secondary"} size="sm" onClick={() => { setReviewAction("reject"); setReviewError(""); }} disabled={reviewLoading}>
                      <X size={14} /> Reject
                    </Button>
                    <Button type="button" variant={reviewAction === "verify" ? "primary" : "secondary"} size="sm" onClick={() => { setReviewAction("verify"); setReviewError(""); }} disabled={reviewLoading}>
                      <CheckCircle2 size={14} /> Verify
                    </Button>
                  </div>

                  {reviewAction === "request_correction" && (
                    <div className={styles.correctionForm}>
                      <p className={styles.reviewMeta}>Select the fields the student must correct, and optionally add a note for each.</p>
                      <ul className={styles.fieldList}>
                        {CORRECTION_FIELDS.map((field) => (
                          <li key={field} className={styles.fieldRow}>
                            <label className={styles.fieldCheckbox}>
                              <input
                                type="checkbox"
                                checked={!!correctionSelected[field]}
                                onChange={(e) => setCorrectionSelected((prev) => ({ ...prev, [field]: e.target.checked }))}
                                disabled={reviewLoading}
                              />
                              {CORRECTION_FIELD_LABELS[field]}
                            </label>
                            {correctionSelected[field] && (
                              <input
                                type="text"
                                className={styles.noteInput}
                                placeholder="Optional note for this field"
                                maxLength={MAX_FIELD_NOTE_LENGTH}
                                value={correctionNotes[field] ?? ""}
                                onChange={(e) => setCorrectionNotes((prev) => ({ ...prev, [field]: e.target.value }))}
                                disabled={reviewLoading}
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                      <div className={styles.formField}>
                        <label>Other issue / additional instructions</label>
                        <textarea
                          rows={3}
                          maxLength={MAX_ADDITIONAL_INSTRUCTIONS_LENGTH}
                          value={additionalInstructions}
                          onChange={(e) => setAdditionalInstructions(e.target.value)}
                          placeholder="Optional additional instructions for the student"
                          disabled={reviewLoading}
                        />
                      </div>
                    </div>
                  )}

                  {reviewAction === "reject" && (
                    <div className={styles.correctionForm}>
                      <div className={styles.formField}>
                        <label>Rejection reason (required)</label>
                        <textarea
                          rows={3}
                          maxLength={MAX_REJECTION_REASON_LENGTH}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="Explain why this application is being rejected"
                          disabled={reviewLoading}
                        />
                      </div>
                    </div>
                  )}

                  {reviewAction === "verify" && (
                    <div className={styles.correctionForm}>
                      <p className={styles.reviewNote}>
                        Verifying approves this application and assigns both official identifiers on the
                        server — the enrollment number (EN########) and the university roll number
                        (MSUYYYY######, for admission year {reviewingStudent.admissionYear ?? "—"}). An
                        identifier the student already has is preserved, and an account that has not been
                        activated yet becomes active so the student can use the portal. If the identifiers
                        cannot be assigned, the application is not verified and an error is shown here.
                      </p>
                    </div>
                  )}
                </>
              )}
            </ModalScrollable>

            {reviewError && <p className={styles.formError} role="alert">{reviewError}</p>}
            {reviewSuccess && <p className={styles.formSuccess} role="status">{reviewSuccess}</p>}

            <div className={styles.modalActions}>
              <Button type="button" variant="secondary" onClick={closeReview} disabled={reviewLoading}>Close</Button>
              {reviewAction && reviewingStudent.applicationStatus === "pending" && (
                <Button
                  type="submit"
                  variant={reviewAction === "reject" ? "danger" : "primary"}
                  loading={reviewLoading}
                  disabled={reviewLoading}
                >
                  {reviewAction === "request_correction" && <><RotateCcw size={14} /> Send correction request</>}
                  {reviewAction === "reject" && <><X size={14} /> Reject application</>}
                  {reviewAction === "verify" && <><CheckCircle2 size={14} /> Verify application</>}
                </Button>
              )}
            </div>
          </form>
        )}
      </Modal>

      {/* ── Phase 5: enrollment ───────────────────────────────────────── */}
      <Modal open={!!enrollingStudent} onClose={closeEnroll} maxWidth={520}>
        {enrollingStudent && (
          <>
            <h3 className={styles.modalTitle}>Assign Official Identifiers</h3>
            <p className={styles.modalDesc}>
              {enrollingStudent.name} · {enrollingStudent.email}
            </p>

            <ModalScrollable>
              <div className={styles.reviewStatusRow}>
                <span className={styles.profileLabel}>Application status</span>
                <Badge variant={applicationStatusVariant(enrollingStudent.applicationStatus)}>
                  {humanizeStatus(enrollingStudent.applicationStatus)}
                </Badge>
                <span className={styles.profileLabel}>Admission year</span>
                <Badge variant="neutral">{enrollingStudent.admissionYear ?? "—"}</Badge>
              </div>

              <div className={styles.profileGrid}>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Course</span><span className={styles.profileValue}>{enrollingStudent.course}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>College</span><span className={styles.profileValue}>{enrollingStudent.college}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>Enrollment no.</span><span className={styles.profileValue}>{enrollResult?.enrollmentNumber || enrollingStudent.enrollmentNumber || "Not assigned"}</span></div>
                <div className={styles.profileItem}><span className={styles.profileLabel}>University roll no.</span><span className={styles.profileValue}>{enrollResult?.universityRollNumber || enrollingStudent.universityRollNumber || "Not assigned"}</span></div>
              </div>

              {enrollResult ? (
                <div className={styles.enrollNotice}>
                  <h4 className={styles.reviewSectionTitle}>
                    <CheckCircle2 size={14} />
                    {enrollResult.alreadyEnrolled ? "Already enrolled" : "Enrollment complete"}
                  </h4>
                  <p className={styles.reviewNote}>
                    {enrollResult.alreadyEnrolled
                      ? "This student was already enrolled. The identifiers below are the existing official values — nothing was reallocated or reassigned."
                      : "These official identifiers were generated on the server. They are permanent: they can never be edited, reused or reassigned."}
                  </p>
                  <div className={styles.identifierList}>
                    <div className={styles.profileItem}>
                      <span className={styles.profileLabel}>Enrollment number</span>
                      <span className={styles.identifierValue}>{enrollResult.enrollmentNumber}</span>
                    </div>
                    <div className={styles.profileItem}>
                      <span className={styles.profileLabel}>University roll number</span>
                      <span className={styles.identifierValue}>{enrollResult.universityRollNumber}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.enrollNotice}>
                    <h4 className={styles.reviewSectionTitle}>
                      <ShieldCheck size={14} /> The missing official identifier will be assigned
                    </h4>
                    <p className={styles.reviewNote}>
                      This student is already approved. Only the identifier they are missing is
                      assigned — the permanent enrollment number (EN########) and/or the university
                      roll number (MSUYYYY######) — generated on the server and globally unique. An
                      identifier that was already issued is never changed. The application status
                      becomes &quot;Enrolled&quot;, and an account that has not been activated yet becomes
                      active.
                    </p>
                  </div>
                  <label className={styles.fieldCheckbox}>
                    <input
                      type="checkbox"
                      checked={enrollConfirmed}
                      onChange={(e) => setEnrollConfirmed(e.target.checked)}
                      disabled={enrollLoading}
                    />
                    I understand that official identifiers will be assigned permanently.
                  </label>
                </>
              )}
            </ModalScrollable>

            {enrollError && <p className={styles.formError} role="alert">{enrollError}</p>}
            {enrollSuccess && <p className={styles.formSuccess} role="status">{enrollSuccess}</p>}

            <div className={styles.modalActions}>
              <Button type="button" variant="secondary" onClick={closeEnroll} disabled={enrollLoading}>
                {enrollResult ? "Close" : "Cancel"}
              </Button>
              {!enrollResult && (
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleEnroll}
                  loading={enrollLoading}
                  disabled={enrollLoading || !enrollConfirmed}
                >
                  <UserCheck size={14} /> Assign identifiers
                </Button>
              )}
            </div>
          </>
        )}
      </Modal>

      {/* Activate / deactivate confirmation */}
      <ConfirmDialog
        open={!!statusTarget}
        onClose={() => { if (!statusLoading) setStatusTarget(null); }}
        onConfirm={handleStatusToggle}
        title={statusTarget?.status === "ACTIVE" ? "Deactivate Student?" : "Activate Student?"}
        description={
          statusTarget?.status === "ACTIVE"
            ? `"${statusTarget?.name}" will remain in the system but be marked inactive. Their data is not deleted.`
            : `"${statusTarget?.name}" will be marked active again.`
        }
        confirmLabel={statusTarget?.status === "ACTIVE" ? "Deactivate" : "Activate"}
        variant={statusTarget?.status === "ACTIVE" ? "warning" : "info"}
        loading={statusLoading}
      />

      {/* Permanent (hard) delete — the server re-validates the typed email */}
      <Modal
        open={!!deletingStudent}
        onClose={() => { if (!deleteLoading) { setDeletingStudent(null); setDeleteError(""); } }}
      >
        {deletingStudent && (
          <>
            <h3 className={styles.modalTitle}>Delete Student Permanently?</h3>
            <p className={styles.modalDesc}>This action permanently removes the student and cannot be undone. This is not deactivation.</p>
            <div className={styles.profileGrid}>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Name</span><span className={styles.profileValue}>{deletingStudent.name}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Email</span><span className={styles.profileValue}>{deletingStudent.email}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Course</span><span className={styles.profileValue}>{deletingStudent.course}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>College</span><span className={styles.profileValue}>{deletingStudent.college}</span></div>
            </div>
            <div className={styles.formField}>
              <label>Type the student&apos;s email to confirm</label>
              <input
                type="text"
                value={deleteConfirmEmail}
                onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                placeholder={deletingStudent.email}
                autoComplete="off"
                disabled={deleteLoading}
              />
            </div>
            {deleteError && <p className={styles.formError}>{deleteError}</p>}
            <div className={styles.modalActions}>
              <Button type="button" variant="secondary" onClick={() => { setDeletingStudent(null); setDeleteError(""); }} disabled={deleteLoading}>Cancel</Button>
              <Button
                type="button"
                variant="danger"
                onClick={handleDelete}
                loading={deleteLoading}
                disabled={deleteConfirmEmail.trim().toLowerCase() !== deletingStudent.email.trim().toLowerCase()}
              >
                Delete Permanently
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
