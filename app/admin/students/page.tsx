"use client";

/**
 * Student Management Page — CRUD interface for managing student accounts.
 *
 * Features:
 * - Paginated table with search (name, email, username) and course filter
 * - View student profile in a modal (read-only)
 * - Edit student fields (name, course, college, phone) — identity fields
 *   (email, aadhar, abcId) are intentionally NOT editable
 *
 * Data flow:
 *   1. GET /api/admin/students — lists students with pagination + search
 *   2. PUT /api/admin/students — updates a single student by ID
 *   3. All requests include JWT via Authorization header
 *
 * Security:
 * - All endpoints are protected by authenticateAdmin() (JWT + role check)
 * - Server validates phone is exactly 10 digits before accepting update
 * - The edit form does not expose password, aadhar, or abcId fields
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/components/ui/* (Card, Button, Modal)
 *   - @/components/empty-state, @/components/error-state
 *   - GET + PUT /api/admin/students (server-side routes)
 */

import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

type StudentStatus = "ACTIVE" | "INACTIVE";

interface Student {
  id: string;
  name: string;
  email: string;
  username: string;
  course: string;
  college: string;
  phone: string;
  status: StudentStatus;
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

export default function AdminStudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [filters, setFilters] = useState<Filters>({ courses: [] });
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
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

  const fetchStudents = useCallback(async (page = 1) => {
    const token = getStoredToken();
    if (!token) return;
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({ page: page.toString(), limit: "20" });
      if (search) params.set("search", search);
      if (courseFilter) params.set("course", courseFilter);
      if (statusFilter) params.set("status", statusFilter);

      const res = await fetch(`/api/admin/students?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) { setError("Unable to load students."); return; }

      const data = await res.json();
      if (data.success) {
        setStudents(data.data);
        setPagination(data.pagination);
        setFilters(data.filters);
      }
    } catch {
      setError("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }, [search, courseFilter, statusFilter]);

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

  function statusVariant(status: StudentStatus): "success" | "neutral" {
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

    const nextStatus: StudentStatus = statusTarget.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";

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

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input type="text" placeholder="Search by name, email, or username..." value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (<button type="button" className={styles.clearBtn} onClick={() => { setSearch(""); setTimeout(() => fetchStudents(1), 0); }}><X size={14} /></button>)}
            </div>
            <Button type="submit" variant="primary" size="sm"><Search size={14} /> Search</Button>
          </form>
          <div className={styles.filterRow}>
            <Filter size={14} />
            <select value={courseFilter} onChange={(e) => { setCourseFilter(e.target.value); setTimeout(() => fetchStudents(1), 0); }} className={styles.select}>
              <option value="">All Courses</option>
              {filters.courses.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setTimeout(() => fetchStudents(1), 0); }} className={styles.select} aria-label="Filter by status">
              <option value="">All Status</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
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
                <thead><tr><th>Name</th><th>Email</th><th>Course</th><th>College</th><th>Status</th><th>Registered</th><th>Actions</th></tr></thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.id}>
                      <td className={styles.nameCell}>{student.name}</td>
                      <td className={styles.emailCell}>{student.email}</td>
                      <td>{student.course}</td>
                      <td className={styles.collegeCell}>{student.college}</td>
                      <td><Badge variant={statusVariant(student.status)}>{student.status === "ACTIVE" ? "Active" : "Inactive"}</Badge></td>
                      <td>{formatDate(student.registeredAt)}</td>
                      <td className={styles.actionsCell}>
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
                      <Button variant="ghost" size="sm" iconOnly onClick={() => setViewingStudent(student)} title="View profile" aria-label={`View profile of ${student.name}`}><Eye size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openEdit(student)} title="Edit student" aria-label={`Edit ${student.name}`}><Edit3 size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openStatusToggle(student)} title={student.status === "ACTIVE" ? "Deactivate" : "Activate"} aria-label={`${student.status === "ACTIVE" ? "Deactivate" : "Activate"} ${student.name}`}><Power size={15} /></Button>
                      <Button variant="danger" size="sm" iconOnly onClick={() => openDelete(student)} title="Delete permanently" aria-label={`Delete ${student.name} permanently`}><Trash2 size={15} /></Button>
                    </>
                  }
                >
                  <RecordField label="Course">{student.course}</RecordField>
                  <RecordField label="College">{student.college}</RecordField>
                  <RecordField label="Status"><Badge variant={statusVariant(student.status)}>{student.status === "ACTIVE" ? "Active" : "Inactive"}</Badge></RecordField>
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
