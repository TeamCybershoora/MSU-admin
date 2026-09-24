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
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Modal from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

interface Student {
  id: string;
  name: string;
  email: string;
  username: string;
  course: string;
  college: string;
  phone: string;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
  }, [search, courseFilter]);

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
                <thead><tr><th>Name</th><th>Email</th><th>Course</th><th>College</th><th>Registered</th><th>Actions</th></tr></thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.id}>
                      <td className={styles.nameCell}>{student.name}</td>
                      <td className={styles.emailCell}>{student.email}</td>
                      <td>{student.course}</td>
                      <td className={styles.collegeCell}>{student.college}</td>
                      <td>{formatDate(student.registeredAt)}</td>
                      <td className={styles.actionsCell}>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setViewingStudent(student)} title="View profile"><Eye size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openEdit(student)} title="Edit student"><Edit3 size={15} /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
    </div>
  );
}
