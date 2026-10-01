"use client";

/**
 * Notice Management Page — CRUD for university notices, circulars, and news.
 *
 * Features:
 * - Paginated table with search (title, summary, category) and multi-filter
 *   (content type, category, status)
 * - Create/edit notices with title, summary, content, category, status,
 *   and optional attachment references
 * - Soft-delete notices (sets isDeleted flag, hidden from public API)
 * - Toggle "new" and "important" badges on notices
 *
 * Data flow:
 *   1. GET /api/admin/notices — lists all notices (including drafts and deleted)
 *   2. POST /api/admin/notices — creates a new notice
 *   3. PUT /api/admin/notices — updates an existing notice by ID
 *   4. DELETE /api/admin/notices — soft-deletes (marks isDeleted=true)
 *
 * Security:
 * - All endpoints are protected by authenticateAdmin() (JWT + role check)
 * - Server validates required fields and enum values (category, status)
 * - Public API (GET /api/notices) only returns published, non-deleted notices
 *
 * Notice categories and content types are defined in @/lib/notice-types.ts
 * (single source of truth — do NOT duplicate the category list).
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/lib/notice-types (NOTICE_CATEGORIES, VALID_CONTENT_TYPES, types)
 *   - @/components/ui/* (Card, Button, Badge, Modal, ConfirmDialog)
 *   - @/components/empty-state, @/components/error-state
 *   - GET/POST/PUT/DELETE /api/admin/notices (server-side routes)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Filter, Eye, Edit3, ChevronLeft, ChevronRight, FileText, X, Plus, Trash2 } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import { NOTICE_CATEGORIES, VALID_CONTENT_TYPES, type NoticeCategory, type NoticeStatus, type ContentType } from "@/lib/notice-types";
import styles from "./page.module.css";

interface NoticeRecord { id: string; title: string; summary: string; content: string; category: NoticeCategory; contentType: ContentType; publishedDate: string; isNew: boolean; isImportant: boolean; status: NoticeStatus; attachmentName: string; attachmentUrl: string; }
interface Pagination { page: number; limit: number; total: number; totalPages: number; }
interface FormState { title: string; summary: string; content: string; category: string; contentType: ContentType; publishedDate: string; status: NoticeStatus; isNewNotice: boolean; isImportant: boolean; attachmentName: string; attachmentUrl: string; }

function blankForm(): FormState {
  return { title: "", summary: "", content: "", category: "", contentType: "notice", publishedDate: new Date().toISOString().split("T")[0], status: "draft", isNewNotice: false, isImportant: false, attachmentName: "", attachmentUrl: "" };
}

function getStatusVariant(s: NoticeStatus): "success" | "info" { return s === "published" ? "success" : "info"; }
function getCategoryVariant(c: string): "danger" | "warning" | "success" | "info" | "neutral" {
  switch (c) { case "Examination": return "danger"; case "Admission": return "info"; case "Academic": return "warning"; case "General": return "success"; case "Recruitment": return "warning"; case "Student": return "info"; default: return "neutral"; }
}

export default function AdminNoticesPage() {
  const [notices, setNotices] = useState<NoticeRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [contentTypeFilter, setContentTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [viewingNotice, setViewingNotice] = useState<NoticeRecord | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(blankForm());
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");

  const [showEditForm, setShowEditForm] = useState(false);
  const [editingNoticeId, setEditingNoticeId] = useState("");
  const [editForm, setEditForm] = useState<FormState>(blankForm());
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [editSuccess, setEditSuccess] = useState("");

  const [deletingNotice, setDeletingNotice] = useState<NoticeRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Monotonic request id. Only the newest request is allowed to write state,
  // so a slow earlier response can never overwrite a newer (filtered) one.
  const requestSeq = useRef(0);

  const fetchNotices = useCallback(async (page = 1) => {
    const token = getStoredToken(); if (!token) return;
    const seq = ++requestSeq.current;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: "20" });
      if (search) params.set("search", search);
      if (categoryFilter) params.set("category", categoryFilter);
      if (contentTypeFilter) params.set("contentType", contentTypeFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/notices?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (seq !== requestSeq.current) return;
      if (!res.ok) { setError("Unable to load notices."); return; }
      const data = await res.json();
      if (seq !== requestSeq.current) return;
      if (data.success) { setNotices(data.data); setPagination(data.pagination); }
    } catch { if (seq === requestSeq.current) setError("Unable to connect to server."); } finally { if (seq === requestSeq.current) setLoading(false); }
  }, [search, categoryFilter, contentTypeFilter, statusFilter]);

  // Single source of refetch: this callback's identity changes with every
  // filter/search value, so the effect below refetches with the NEW values.
  // (Filter handlers must NOT refetch themselves — see the comment on the
  // selects: an immediate call there would run a stale closure.)
  useEffect(() => { fetchNotices(1); }, [fetchNotices]);

  function handleSearch(e: React.FormEvent) { e.preventDefault(); fetchNotices(1); }
  function formatDate(d: string) { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  function updateFormFields(setter: React.Dispatch<React.SetStateAction<FormState>>, field: keyof FormState, value: string | boolean) { setter((prev) => ({ ...prev, [field]: value })); }
  function buildRequestBody(form: FormState) {
    return { title: form.title.trim(), summary: form.summary.trim(), content: form.content.trim(), category: form.category, contentType: form.contentType, publishedDate: form.publishedDate, status: form.status, isNewNotice: form.isNewNotice, isImportant: form.isImportant, attachmentName: form.attachmentName.trim(), attachmentUrl: form.attachmentUrl.trim() };
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault(); if (createLoading) return;
    if (!createForm.title.trim() || !createForm.summary.trim() || !createForm.content.trim() || !createForm.category) { setCreateError("Title, summary, content, and category are required."); return; }
    setCreateLoading(true); setCreateError(""); setCreateSuccess("");
    const token = getStoredToken(); if (!token) { setCreateError("Not authenticated."); setCreateLoading(false); return; }
    try {
      const res = await fetch("/api/admin/notices", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(buildRequestBody(createForm)) });
      const data = await res.json();
      if (!data.success) { setCreateError(data.message || "Failed to create notice."); return; }
      setCreateSuccess("Notice created!");
      setTimeout(() => { setShowCreateForm(false); setCreateSuccess(""); setCreateForm(blankForm()); fetchNotices(1); }, 1000);
    } catch { setCreateError("Unable to connect to server."); } finally { setCreateLoading(false); }
  }

  function openEditForm(n: NoticeRecord) {
    setShowEditForm(true); setEditingNoticeId(n.id); setEditError(""); setEditSuccess("");
    setEditForm({ title: n.title, summary: n.summary, content: n.content, category: n.category, contentType: n.contentType || "notice", publishedDate: n.publishedDate ? new Date(n.publishedDate).toISOString().split("T")[0] : "", status: n.status, isNewNotice: n.isNew, isImportant: n.isImportant, attachmentName: n.attachmentName || "", attachmentUrl: n.attachmentUrl || "" });
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault(); if (editLoading || !editingNoticeId) return;
    if (!editForm.title.trim() || !editForm.summary.trim() || !editForm.content.trim() || !editForm.category) { setEditError("Title, summary, content, and category are required."); return; }
    setEditLoading(true); setEditError(""); setEditSuccess("");
    const token = getStoredToken(); if (!token) { setEditError("Not authenticated."); setEditLoading(false); return; }
    try {
      const res = await fetch("/api/admin/notices", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ noticeId: editingNoticeId, ...buildRequestBody(editForm) }) });
      const data = await res.json();
      if (!data.success) { setEditError(data.message || "Failed to update."); return; }
      setEditSuccess("Notice updated!");
      setTimeout(() => { setShowEditForm(false); setEditingNoticeId(""); setEditSuccess(""); setEditForm(blankForm()); fetchNotices(pagination.page); }, 1000);
    } catch { setEditError("Unable to connect to server."); } finally { setEditLoading(false); }
  }

  async function handleDelete() {
    if (!deletingNotice || deleteLoading) return;
    setDeleteLoading(true);
    const token = getStoredToken(); if (!token) return;
    try {
      const res = await fetch("/api/admin/notices", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ noticeId: deletingNotice.id }) });
      const data = await res.json();
      if (data.success) { setDeletingNotice(null); fetchNotices(pagination.page); }
    } catch { /* ignore */ } finally { setDeleteLoading(false); setDeletingNotice(null); }
  }

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input type="text" placeholder="Search by title, summary, or category..." value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (<button type="button" className={styles.clearBtn} onClick={() => setSearch("")}><X size={14} /></button>)}
            </div>
            <Button type="submit" variant="primary" size="sm"><Search size={14} /> Search</Button>
          </form>
          <div className={styles.toolbarRight}>
            <div className={styles.filterRow}>
              <Filter size={14} />
              {/* Filter selects only update state. The refetch happens in the
                  effect above, with the new value — calling fetchNotices()
                  here would use the previous render's closure (stale filter). */}
              <select value={contentTypeFilter} onChange={(e) => setContentTypeFilter(e.target.value)} className={styles.select}>
                <option value="">All Types</option>
                {VALID_CONTENT_TYPES.map((ct) => (<option key={ct} value={ct}>{ct.charAt(0).toUpperCase() + ct.slice(1)}</option>))}
              </select>
            </div>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className={styles.select}>
              <option value="">All Categories</option>
              {NOTICE_CATEGORIES.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={styles.select}>
              <option value="">All Status</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
            </select>
            <Button variant="primary" size="sm" onClick={() => { setCreateForm(blankForm()); setCreateError(""); setCreateSuccess(""); setShowCreateForm(true); }}><Plus size={14} /> Add Notice</Button>
          </div>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader title={`Notices (${pagination.total})`} subtitle={`Page ${pagination.page} of ${pagination.totalPages || 1}`} />
        {loading ? (
          <div className={styles.loadingState}><div className={styles.spinner} /><p>Loading notices...</p></div>
        ) : error ? (
          <ErrorState title="Unable to load notices" description={error} onRetry={() => fetchNotices(pagination.page)} />
        ) : notices.length === 0 ? (
          <EmptyState icon={<FileText />} title="No notices found" description="No notice records match your search." />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead><tr><th>Title</th><th>Type</th><th>Category</th><th>Published</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {notices.map((n) => (
                    <tr key={n.id}>
                      <td className={styles.nameCell}>{n.title}</td>
                      <td><Badge variant="neutral">{n.contentType?.charAt(0).toUpperCase()}{n.contentType?.slice(1)}</Badge></td>
                      <td><Badge variant={getCategoryVariant(n.category)}>{n.category}</Badge></td>
                      <td>{formatDate(n.publishedDate)}</td>
                      <td><Badge variant={getStatusVariant(n.status)}>{n.status}</Badge></td>
                      <td className={styles.actionsCell}>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setViewingNotice(n)} title="View"><Eye size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => openEditForm(n)} title="Edit"><Edit3 size={15} /></Button>
                        <Button variant="ghost" size="sm" iconOnly onClick={() => setDeletingNotice(n)} title="Delete"><Trash2 size={15} /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile only (<=600px): same notices array as the table above,
                rendered as record cards. Hidden on desktop/tablet. */}
            <RecordList>
              {notices.map((n) => (
                <RecordCard
                  key={n.id}
                  title={n.title}
                  subtitle={n.contentType ? n.contentType.charAt(0).toUpperCase() + n.contentType.slice(1) : "Notice"}
                  actions={
                    <>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => setViewingNotice(n)} title="View" aria-label={`View notice: ${n.title}`}><Eye size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => openEditForm(n)} title="Edit" aria-label={`Edit notice: ${n.title}`}><Edit3 size={15} /></Button>
                      <Button variant="ghost" size="sm" iconOnly onClick={() => setDeletingNotice(n)} title="Delete" aria-label={`Delete notice: ${n.title}`}><Trash2 size={15} /></Button>
                    </>
                  }
                >
                  <RecordField label="Category"><Badge variant={getCategoryVariant(n.category)}>{n.category}</Badge></RecordField>
                  <RecordField label="Published">{formatDate(n.publishedDate)}</RecordField>
                  <RecordField label="Status"><Badge variant={getStatusVariant(n.status)}>{n.status}</Badge></RecordField>
                </RecordCard>
              ))}
            </RecordList>

            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button variant="secondary" size="sm" disabled={pagination.page <= 1} onClick={() => fetchNotices(pagination.page - 1)}><ChevronLeft size={14} /> Previous</Button>
                <span className={styles.pageInfo}>Page {pagination.page} of {pagination.totalPages}</span>
                <Button variant="secondary" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchNotices(pagination.page + 1)}>Next <ChevronRight size={14} /></Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* View Modal */}
      <Modal open={!!viewingNotice} onClose={() => setViewingNotice(null)}>
        {viewingNotice && (
          <>
            <h3 className={styles.modalTitle}>Notice Details</h3>
            <div className={styles.profileGrid}>
              <div className={styles.profileItemFull}><span className={styles.profileLabel}>Title</span><span className={styles.profileValue}>{viewingNotice.title}</span></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Category</span><Badge variant={getCategoryVariant(viewingNotice.category)}>{viewingNotice.category}</Badge></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Status</span><Badge variant={getStatusVariant(viewingNotice.status)}>{viewingNotice.status}</Badge></div>
              <div className={styles.profileItem}><span className={styles.profileLabel}>Published</span><span className={styles.profileValue}>{formatDate(viewingNotice.publishedDate)}</span></div>
              <div className={styles.profileItemFull}><span className={styles.profileLabel}>Summary</span><span className={styles.profileValue}>{viewingNotice.summary}</span></div>
              <div className={styles.profileItemFull}><span className={styles.profileLabel}>Content</span><span className={styles.profileValue}>{viewingNotice.content}</span></div>
            </div>
            <div className={styles.modalActions}><Button variant="secondary" onClick={() => setViewingNotice(null)}>Close</Button></div>
          </>
        )}
      </Modal>

      {/* Create Modal */}
      <Modal open={showCreateForm} onClose={() => { if (!createLoading) { setShowCreateForm(false); setCreateError(""); setCreateSuccess(""); } }} maxWidth={600}>
        <form onSubmit={handleCreateSubmit}>
          <h3 className={styles.modalTitle}>Add New Notice</h3>
          <div className={styles.formFields}>
            <div className={styles.formField}><label>Title *</label><input type="text" placeholder="e.g. Semester Exam Schedule" value={createForm.title} onChange={(e) => updateFormFields(setCreateForm, "title", e.target.value)} /></div>
            <div className={styles.formField}><label>Summary *</label><textarea rows={2} placeholder="Brief summary..." value={createForm.summary} onChange={(e) => updateFormFields(setCreateForm, "summary", e.target.value)} style={{ padding: "0.5rem", borderRadius: "8px", border: "1.5px solid rgba(21,97,109,0.12)", fontSize: "0.85rem", resize: "vertical" }} /></div>
            <div className={styles.formField}><label>Content *</label><textarea rows={4} placeholder="Full notice content..." value={createForm.content} onChange={(e) => updateFormFields(setCreateForm, "content", e.target.value)} style={{ padding: "0.5rem", borderRadius: "8px", border: "1.5px solid rgba(21,97,109,0.12)", fontSize: "0.85rem", resize: "vertical" }} /></div>
            <div className={styles.formField}><label>Category *</label><select value={createForm.category} onChange={(e) => updateFormFields(setCreateForm, "category", e.target.value)}><option value="">Select Category</option>{NOTICE_CATEGORIES.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}</select></div>
            <div className={styles.formField}><label>Content Type</label><select value={createForm.contentType} onChange={(e) => updateFormFields(setCreateForm, "contentType", e.target.value as ContentType)}>{VALID_CONTENT_TYPES.map((ct) => (<option key={ct} value={ct}>{ct.charAt(0).toUpperCase() + ct.slice(1)}</option>))}</select></div>
            <div className={styles.formField}><label>Published Date *</label><input type="date" value={createForm.publishedDate} onChange={(e) => updateFormFields(setCreateForm, "publishedDate", e.target.value)} /></div>
            <div className={styles.formField}><label>Status</label><select value={createForm.status} onChange={(e) => updateFormFields(setCreateForm, "status", e.target.value as NoticeStatus)}><option value="draft">Draft</option><option value="published">Published</option></select></div>
            <div className={styles.formField}><label><input type="checkbox" checked={createForm.isNewNotice} onChange={(e) => updateFormFields(setCreateForm, "isNewNotice", e.target.checked)} /> Mark as New</label></div>
            <div className={styles.formField}><label><input type="checkbox" checked={createForm.isImportant} onChange={(e) => updateFormFields(setCreateForm, "isImportant", e.target.checked)} /> Mark as Important</label></div>
          </div>
          {createError && <p className={styles.formError}>{createError}</p>}
          {createSuccess && <p className={styles.formSuccess}>{createSuccess}</p>}
          <div className={styles.modalActions}>
            <Button type="button" variant="secondary" onClick={() => { setShowCreateForm(false); setCreateError(""); setCreateSuccess(""); }} disabled={createLoading}>Cancel</Button>
            <Button type="submit" variant="primary" loading={createLoading}>Create Notice</Button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal open={showEditForm} onClose={() => { if (!editLoading) { setShowEditForm(false); setEditError(""); setEditSuccess(""); } }} maxWidth={600}>
        <form onSubmit={handleEditSubmit}>
          <h3 className={styles.modalTitle}>Edit Notice</h3>
          <div className={styles.formFields}>
            <div className={styles.formField}><label>Title *</label><input type="text" value={editForm.title} onChange={(e) => updateFormFields(setEditForm, "title", e.target.value)} /></div>
            <div className={styles.formField}><label>Summary *</label><textarea rows={2} value={editForm.summary} onChange={(e) => updateFormFields(setEditForm, "summary", e.target.value)} style={{ padding: "0.5rem", borderRadius: "8px", border: "1.5px solid rgba(21,97,109,0.12)", fontSize: "0.85rem", resize: "vertical" }} /></div>
            <div className={styles.formField}><label>Content *</label><textarea rows={4} value={editForm.content} onChange={(e) => updateFormFields(setEditForm, "content", e.target.value)} style={{ padding: "0.5rem", borderRadius: "8px", border: "1.5px solid rgba(21,97,109,0.12)", fontSize: "0.85rem", resize: "vertical" }} /></div>
            <div className={styles.formField}><label>Category *</label><select value={editForm.category} onChange={(e) => updateFormFields(setEditForm, "category", e.target.value)}><option value="">Select</option>{NOTICE_CATEGORIES.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}</select></div>
            <div className={styles.formField}><label>Content Type</label><select value={editForm.contentType} onChange={(e) => updateFormFields(setEditForm, "contentType", e.target.value as ContentType)}>{VALID_CONTENT_TYPES.map((ct) => (<option key={ct} value={ct}>{ct.charAt(0).toUpperCase() + ct.slice(1)}</option>))}</select></div>
            <div className={styles.formField}><label>Published Date *</label><input type="date" value={editForm.publishedDate} onChange={(e) => updateFormFields(setEditForm, "publishedDate", e.target.value)} /></div>
            <div className={styles.formField}><label>Status</label><select value={editForm.status} onChange={(e) => updateFormFields(setEditForm, "status", e.target.value as NoticeStatus)}><option value="draft">Draft</option><option value="published">Published</option></select></div>
            <div className={styles.formField}><label><input type="checkbox" checked={editForm.isNewNotice} onChange={(e) => updateFormFields(setEditForm, "isNewNotice", e.target.checked)} /> Mark as New</label></div>
            <div className={styles.formField}><label><input type="checkbox" checked={editForm.isImportant} onChange={(e) => updateFormFields(setEditForm, "isImportant", e.target.checked)} /> Mark as Important</label></div>
          </div>
          {editError && <p className={styles.formError}>{editError}</p>}
          {editSuccess && <p className={styles.formSuccess}>{editSuccess}</p>}
          <div className={styles.modalActions}>
            <Button type="button" variant="secondary" onClick={() => { setShowEditForm(false); setEditError(""); setEditSuccess(""); }} disabled={editLoading}>Cancel</Button>
            <Button type="submit" variant="primary" loading={editLoading}>Update Notice</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog open={!!deletingNotice} onClose={() => { if (!deleteLoading) setDeletingNotice(null); }} onConfirm={handleDelete} title="Delete Notice" description={`Delete "${deletingNotice?.title}"? This will hide it from the public page.`} confirmLabel="Delete" variant="danger" loading={deleteLoading} />
    </div>
  );
}
