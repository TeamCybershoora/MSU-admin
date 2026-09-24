"use client";

/**
 * College Management Page — CRUD for affiliated colleges + PDF config.
 *
 * Features:
 * - Paginated table with search (college name) and district filter
 * - Create/edit/delete colleges (name, code, district)
 * - Manage the common college directory PDF URL (stored in SiteConfig)
 *
 * Data flow:
 *   1. GET /api/admin/colleges — lists colleges with pagination + search
 *   2. POST /api/admin/colleges — creates a new college
 *   3. PUT /api/admin/colleges — updates an existing college by ID
 *   4. DELETE /api/admin/colleges — hard-deletes a college
 *   5. GET /api/admin/site-config?key=college_pdf_url — fetches PDF URL
 *   6. PUT /api/admin/site-config — saves the PDF URL
 *
 * Security:
 * - All endpoints are protected by authenticateAdmin() (JWT + role check)
 * - College names are unique (case-insensitive) enforced by MongoDB index
 * - District is validated against a fixed list: Saharanpur, Shamli, Muzaffarnagar
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/components/ui/* (Card, CardHeader, Button, Modal, ConfirmDialog)
 *   - @/components/empty-state, @/components/error-state
 *   - GET/POST/PUT/DELETE /api/admin/colleges (server-side routes)
 *   - GET/PUT /api/admin/site-config (server-side routes)
 */

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Edit3,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Building2,
  Plus,
  X,
  FileText,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

interface College {
  id: string;
  collegeName: string;
  collegeCode: string;
  district: string;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function AdminCollegesPage() {
  const [colleges, setColleges] = useState<College[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [search, setSearch] = useState("");
  const [districtFilter, setDistrictFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const DISTRICTS = ["Saharanpur", "Shamli", "Muzaffarnagar"];

  const [showForm, setShowForm] = useState(false);
  const [editingCollege, setEditingCollege] = useState<College | null>(null);
  const [formName, setFormName] = useState("");
  const [formCode, setFormCode] = useState("");
  const [formDistrict, setFormDistrict] = useState("");
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");

  const [deletingCollege, setDeletingCollege] = useState<College | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfSuccess, setPdfSuccess] = useState("");
  const [pdfError, setPdfError] = useState("");

  const fetchColleges = useCallback(async (page = 1) => {
    const token = getStoredToken();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: "20" });
      if (search) params.set("search", search);
      if (districtFilter) params.set("district", districtFilter);
      const res = await fetch(`/api/admin/colleges?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { setError("Unable to load colleges."); return; }
      const data = await res.json();
      if (data.success) { setColleges(data.data); setPagination(data.pagination); }
    } catch { setError("Unable to connect to server."); } finally { setLoading(false); }
  }, [search, districtFilter]);

  const fetchPdfConfig = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    try {
      const params = new URLSearchParams({ key: "college_pdf_url" });
      const res = await fetch(`/api/admin/site-config?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) { const data = await res.json(); if (data.success && data.data?.value) setPdfUrl(data.data.value); }
    } catch { /* Non-critical */ }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchColleges(1); }, [fetchColleges]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchPdfConfig(); }, [fetchPdfConfig]);

  function handleSearch(e: React.FormEvent) { e.preventDefault(); fetchColleges(1); }

  function openCreateForm() { setEditingCollege(null); setFormName(""); setFormCode(""); setFormDistrict(""); setFormError(""); setFormSuccess(""); setShowForm(true); }
  function openEditForm(college: College) { setEditingCollege(college); setFormName(college.collegeName); setFormCode(college.collegeCode); setFormDistrict(college.district || ""); setFormError(""); setFormSuccess(""); setShowForm(true); }

  async function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formLoading) return;
    if (!formName.trim()) { setFormError("College name is required."); return; }
    setFormLoading(true); setFormError(""); setFormSuccess("");
    const token = getStoredToken(); if (!token) return;
    try {
      const isEditing = !!editingCollege;
      const body: Record<string, string> = { collegeName: formName.trim(), collegeCode: formCode.trim(), district: formDistrict };
      if (isEditing) body.collegeId = editingCollege!.id;
      const res = await fetch("/api/admin/colleges", { method: isEditing ? "PUT" : "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.success) { setFormError(data.message || "Failed to save college."); return; }
      setFormSuccess(editingCollege ? "College updated!" : "College created!");
      fetchColleges(pagination.page);
      setTimeout(() => { setShowForm(false); setFormSuccess(""); }, 1200);
    } catch { setFormError("Unable to connect to server."); } finally { setFormLoading(false); }
  }

  async function handleDelete() {
    if (!deletingCollege || deleteLoading) return;
    setDeleteLoading(true);
    const token = getStoredToken(); if (!token) return;
    try {
      const res = await fetch("/api/admin/colleges", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ collegeId: deletingCollege.id }) });
      const data = await res.json();
      if (data.success) { setDeletingCollege(null); fetchColleges(pagination.page); }
    } catch { /* ignore */ } finally { setDeleteLoading(false); setDeletingCollege(null); }
  }

  async function handlePdfSave() {
    const token = getStoredToken(); if (!token) return;
    setPdfLoading(true); setPdfError(""); setPdfSuccess("");
    try {
      const res = await fetch("/api/admin/site-config", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ key: "college_pdf_url", value: pdfUrl.trim() }) });
      const data = await res.json();
      if (!data.success) { setPdfError(data.message || "Failed to update PDF URL."); return; }
      setPdfSuccess("PDF URL updated successfully!");
      setTimeout(() => setPdfSuccess(""), 3000);
    } catch { setPdfError("Unable to connect to server."); } finally { setPdfLoading(false); }
  }

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <CardHeader title="College PDF" subtitle="Manage the common college directory PDF" />
        <div className={styles.toolbar}>
          <div className={styles.searchInput}>
            <FileText size={16} />
            <input type="url" placeholder="https://example.com/college-list.pdf" value={pdfUrl} onChange={(e) => setPdfUrl(e.target.value)} />
          </div>
          <Button variant="primary" size="sm" onClick={handlePdfSave} loading={pdfLoading}>Save</Button>
        </div>
        {pdfError && <p className={styles.formError}>{pdfError}</p>}
        {pdfSuccess && <p className={styles.formSuccess}>{pdfSuccess}</p>}
      </Card>

      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input type="text" placeholder="Search colleges..." value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (<button type="button" className={styles.clearBtn} onClick={() => { setSearch(""); setTimeout(() => fetchColleges(1), 0); }}><X size={14} /></button>)}
            </div>
            <select value={districtFilter} onChange={(e) => setDistrictFilter(e.target.value)} className={styles.select}>
              <option value="">All Districts</option>
              {DISTRICTS.map((d) => (<option key={d} value={d}>{d}</option>))}
            </select>
            <Button type="submit" variant="primary" size="sm"><Search size={14} /> Search</Button>
          </form>
          <Button variant="primary" size="sm" onClick={openCreateForm}><Plus size={14} /> Add College</Button>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader title={`Colleges (${pagination.total})`} subtitle={`Page ${pagination.page} of ${pagination.totalPages || 1}`} />
        {loading ? (
          <div className={styles.loadingState}><div className={styles.spinner} /><p>Loading colleges...</p></div>
        ) : error ? (
          <ErrorState title="Unable to load colleges" description={error} onRetry={() => fetchColleges(pagination.page)} />
        ) : colleges.length === 0 ? (
          <EmptyState icon={<Building2 />} title="No colleges found" description={search ? "No colleges match your search." : "No colleges have been added yet."} />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead><tr><th>#</th><th>College Name</th><th>Code</th><th>District</th><th>Actions</th></tr></thead>
                <tbody>
                  {colleges.map((college, index) => (
                    <tr key={college.id}>
                      <td>{(pagination.page - 1) * pagination.limit + index + 1}</td>
                      <td className={styles.nameCell}>{college.collegeName}</td>
                      <td>{college.collegeCode || "—"}</td>
                      <td>{college.district || "—"}</td>
                      <td className={styles.actionsCell}>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openEditForm(college)} title="Edit"><Edit3 size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setDeletingCollege(college)} title="Delete"><Trash2 size={15} /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button variant="secondary" size="sm" disabled={pagination.page <= 1} onClick={() => fetchColleges(pagination.page - 1)}><ChevronLeft size={14} /> Previous</Button>
                <span className={styles.pageInfo}>Page {pagination.page} of {pagination.totalPages}</span>
                <Button variant="secondary" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchColleges(pagination.page + 1)}>Next <ChevronRight size={14} /></Button>
              </div>
            )}
          </>
        )}
      </Card>

      <Modal open={showForm} onClose={() => { if (!formLoading) { setShowForm(false); setFormError(""); setFormSuccess(""); } }}>
        <form onSubmit={handleFormSubmit}>
          <h3 className={styles.modalTitle}>{editingCollege ? "Edit College" : "Add College"}</h3>
          <p className={styles.modalDesc}>{editingCollege ? "Update the college information." : "Enter the college details. College Code is optional."}</p>
          <div className={styles.formFields}>
            <div className={styles.formField}><label>College Name *</label><input type="text" placeholder="e.g. ABC College" value={formName} onChange={(e) => setFormName(e.target.value)} required autoFocus /></div>
            <div className={styles.formField}><label>College Code</label><input type="text" placeholder="Optional" value={formCode} onChange={(e) => setFormCode(e.target.value)} /></div>
            <div className={styles.formField}><label>District</label><select value={formDistrict} onChange={(e) => setFormDistrict(e.target.value)}><option value="">Select District</option>{DISTRICTS.map((d) => (<option key={d} value={d}>{d}</option>))}</select></div>
          </div>
          {formError && <p className={styles.formError}>{formError}</p>}
          {formSuccess && <p className={styles.formSuccess}>{formSuccess}</p>}
          <div className={styles.modalActions}>
            <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setFormError(""); setFormSuccess(""); }} disabled={formLoading}>Cancel</Button>
            <Button type="submit" variant="primary" loading={formLoading}>{editingCollege ? "Update" : "Create"}</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog open={!!deletingCollege} onClose={() => { if (!deleteLoading) setDeletingCollege(null); }} onConfirm={handleDelete} title="Delete College" description={`Are you sure you want to delete "${deletingCollege?.collegeName}"?`} confirmLabel="Delete" variant="danger" loading={deleteLoading} />
    </div>
  );
}
