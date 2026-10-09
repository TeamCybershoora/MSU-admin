"use client";

/**
 * News Management Page — CRUD for the dedicated university News system.
 *
 * This page manages the `News` collection ONLY. It never reads or writes
 * Notices, and Notices never read or write News.
 *
 * Features:
 * - Paginated table (desktop) / record cards (mobile) with search + status filter
 * - Create/edit News with title, heading/summary, content, publication date,
 *   published/draft status and a featured image (upload / replace / remove)
 * - Quick Publish / Unpublish without opening the edit form
 * - Preview a record (including its featured image)
 * - Soft-delete (the record and its image bytes are preserved, hidden from
 *   the public API)
 *
 * Data flow:
 *   1. GET    /api/admin/news          — list (drafts + published, not deleted)
 *   2. POST   /api/admin/news          — create
 *   3. PUT    /api/admin/news          — update / publish / unpublish
 *   4. DELETE /api/admin/news          — soft-delete
 *   5. POST   /api/admin/images/upload — shared secure image upload
 *
 * Security: the JWT is attached to every request; all authorization is
 * re-checked server-side by authenticateAdmin(). The UI is never the source
 * of truth.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Search,
  Filter,
  Eye,
  Edit3,
  ChevronLeft,
  ChevronRight,
  Newspaper,
  X,
  Plus,
  Trash2,
  UploadCloud,
  EyeOff,
  CheckCircle2,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import SearchableSelect from "@/components/ui/searchable-select";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import {
  NEWS_STATUSES,
  type NewsStatus,
  type SafeNews,
} from "@/lib/news-types";
import styles from "./page.module.css";

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface FormState {
  title: string;
  summary: string;
  content: string;
  publishedDate: string;
  status: NewsStatus;
  imageId: string;
  imageName: string;
  imageAlt: string;
}

function blankForm(): FormState {
  return {
    title: "",
    summary: "",
    content: "",
    publishedDate: new Date().toISOString().split("T")[0],
    status: "draft",
    imageId: "",
    imageName: "",
    imageAlt: "",
  };
}

function getStatusVariant(s: NewsStatus): "success" | "info" {
  return s === "published" ? "success" : "info";
}

export default function AdminNewsPage() {
  const [items, setItems] = useState<SafeNews[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Featured-image upload state, shared by the create and edit forms (only one
  // is open at a time). `imageFile` is a newly picked file; `imagePreview` is
  // its local object URL.
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const [viewing, setViewing] = useState<SafeNews | null>(null);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(blankForm());
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");

  const [showEditForm, setShowEditForm] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editForm, setEditForm] = useState<FormState>(blankForm());
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [editSuccess, setEditSuccess] = useState("");

  const [deleting, setDeleting] = useState<SafeNews | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Monotonic request id — only the newest request may write state, so a slow
  // earlier response can never overwrite a newer (filtered) one.
  const requestSeq = useRef(0);

  const fetchNews = useCallback(
    async (page = 1) => {
      const token = getStoredToken();
      if (!token) return;
      const seq = ++requestSeq.current;
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          page: page.toString(),
          limit: "20",
        });
        if (search) params.set("search", search);
        if (statusFilter) params.set("status", statusFilter);
        const res = await fetch(`/api/admin/news?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (seq !== requestSeq.current) return;
        if (!res.ok) {
          setError("Unable to load news.");
          return;
        }
        const data = await res.json();
        if (seq !== requestSeq.current) return;
        if (data.success) {
          setItems(data.data);
          setPagination(data.pagination);
        }
      } catch {
        if (seq === requestSeq.current) setError("Unable to connect to server.");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [search, statusFilter]
  );

  // Single source of refetch: this callback's identity changes with every
  // filter/search value, so the effect refetches with the NEW values.
  useEffect(() => {
    fetchNews(1);
  }, [fetchNews]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchNews(1);
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function updateFormFields(
    setter: React.Dispatch<React.SetStateAction<FormState>>,
    field: keyof FormState,
    value: string | boolean
  ) {
    setter((prev) => ({ ...prev, [field]: value }));
  }

  function buildRequestBody(form: FormState, imageId: string, imageName: string) {
    return {
      title: form.title.trim(),
      summary: form.summary.trim(),
      content: form.content.trim(),
      publishedDate: form.publishedDate,
      status: form.status,
      imageId,
      imageName,
      imageAlt: form.imageAlt.trim(),
    };
  }

  function resetImageState() {
    setImageFile(null);
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setImageFile(picked);
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return picked ? URL.createObjectURL(picked) : null;
    });
  }

  function clearImage(setter: React.Dispatch<React.SetStateAction<FormState>>) {
    setter((prev) => ({ ...prev, imageId: "", imageName: "" }));
    resetImageState();
  }

  /** Upload a newly picked file (if any) and return the image id/name to store. */
  async function resolveImage(
    token: string,
    form: FormState
  ): Promise<{ ok: true; imageId: string; imageName: string } | { ok: false; error: string }> {
    let imageId = form.imageId;
    let imageName = form.imageName;
    if (imageFile) {
      const fd = new FormData();
      fd.append("file", imageFile);
      const res = await fetch("/api/admin/images/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json();
      if (!data.success) return { ok: false, error: data.message || "Image upload failed." };
      imageId = data.imageId as string;
      imageName = (data.imageName as string) ?? "";
    }
    return { ok: true, imageId, imageName };
  }

  /** Featured-image field shared by the create and edit modals. */
  function renderImageField(
    form: FormState,
    setter: React.Dispatch<React.SetStateAction<FormState>>
  ) {
    const previewSrc = imagePreview ?? (form.imageId ? `/api/images/${form.imageId}` : null);
    return (
      <div className={styles.formField}>
        <label>Featured Image (optional)</label>
        {previewSrc && (
          <div className={styles.imagePreview}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewSrc} alt="Featured image preview" />
          </div>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleImageChange}
        />
        <span className={styles.formHint}>JPEG, PNG or WebP, up to 5 MB. Shown on the homepage Latest News carousel.</span>
        {(form.imageId || imageFile) && (
          <button
            type="button"
            className={styles.removeImage}
            onClick={() => clearImage(setter)}
          >
            Remove featured image
          </button>
        )}
        <label>Image Alt Text</label>
        <input
          type="text"
          maxLength={200}
          placeholder="e.g. Students at the annual cultural fest"
          value={form.imageAlt}
          onChange={(e) => updateFormFields(setter, "imageAlt", e.target.value)}
        />
      </div>
    );
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (createLoading) return;
    if (!createForm.title.trim() || !createForm.publishedDate) {
      setCreateError("Title and publication date are required.");
      return;
    }
    setCreateLoading(true);
    setCreateError("");
    setCreateSuccess("");
    const token = getStoredToken();
    if (!token) {
      setCreateError("Not authenticated.");
      setCreateLoading(false);
      return;
    }
    try {
      const upload = await resolveImage(token, createForm);
      if (!upload.ok) {
        setCreateError(upload.error);
        return;
      }
      const res = await fetch("/api/admin/news", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(buildRequestBody(createForm, upload.imageId, upload.imageName)),
      });
      const data = await res.json();
      if (!data.success) {
        setCreateError(data.message || "Failed to create news.");
        return;
      }
      setCreateSuccess("News created!");
      setTimeout(() => {
        setShowCreateForm(false);
        setCreateSuccess("");
        setCreateForm(blankForm());
        resetImageState();
        fetchNews(1);
      }, 1000);
    } catch {
      setCreateError("Unable to connect to server.");
    } finally {
      setCreateLoading(false);
    }
  }

  function openEditForm(n: SafeNews) {
    setShowEditForm(true);
    setEditingId(n.id);
    setEditError("");
    setEditSuccess("");
    resetImageState();
    setEditForm({
      title: n.title,
      summary: n.summary || "",
      content: n.content || "",
      publishedDate: n.publishedDate ? new Date(n.publishedDate).toISOString().split("T")[0] : "",
      status: n.status || "draft",
      imageId: n.imageId || "",
      imageName: n.imageName || "",
      imageAlt: n.imageAlt || "",
    });
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editLoading || !editingId) return;
    if (!editForm.title.trim() || !editForm.publishedDate) {
      setEditError("Title and publication date are required.");
      return;
    }
    setEditLoading(true);
    setEditError("");
    setEditSuccess("");
    const token = getStoredToken();
    if (!token) {
      setEditError("Not authenticated.");
      setEditLoading(false);
      return;
    }
    try {
      const upload = await resolveImage(token, editForm);
      if (!upload.ok) {
        setEditError(upload.error);
        return;
      }
      const res = await fetch("/api/admin/news", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          newsId: editingId,
          ...buildRequestBody(editForm, upload.imageId, upload.imageName),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setEditError(data.message || "Failed to update.");
        return;
      }
      setEditSuccess("News updated!");
      setTimeout(() => {
        setShowEditForm(false);
        setEditingId("");
        setEditSuccess("");
        setEditForm(blankForm());
        resetImageState();
        fetchNews(pagination.page);
      }, 1000);
    } catch {
      setEditError("Unable to connect to server.");
    } finally {
      setEditLoading(false);
    }
  }

  /** Quick publish/unpublish — no need to open the full edit form. */
  async function toggleStatus(n: SafeNews) {
    const token = getStoredToken();
    if (!token) return;
    const nextStatus: NewsStatus = n.status === "published" ? "draft" : "published";
    try {
      const res = await fetch("/api/admin/news", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newsId: n.id, status: nextStatus }),
      });
      const data = await res.json();
      if (data.success) fetchNews(pagination.page);
    } catch {
      /* ignore — the table simply keeps its current state */
    }
  }

  async function handleDelete() {
    if (!deleting || deleteLoading) return;
    setDeleteLoading(true);
    const token = getStoredToken();
    if (!token) return;
    try {
      const res = await fetch("/api/admin/news", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newsId: deleting.id }),
      });
      const data = await res.json();
      if (data.success) {
        setDeleting(null);
        fetchNews(pagination.page);
      }
    } catch {
      /* ignore */
    } finally {
      setDeleteLoading(false);
      setDeleting(null);
    }
  }

  const renderActions = (n: SafeNews) => (
    <>
      <Button variant="ghost" size="sm" iconOnly onClick={() => setViewing(n)} title="Preview" aria-label={`Preview news: ${n.title}`}>
        <Eye size={15} />
      </Button>
      <Button variant="ghost" size="sm" iconOnly onClick={() => openEditForm(n)} title="Edit" aria-label={`Edit news: ${n.title}`}>
        <Edit3 size={15} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        onClick={() => toggleStatus(n)}
        title={n.status === "published" ? "Unpublish" : "Publish"}
        aria-label={n.status === "published" ? `Unpublish news: ${n.title}` : `Publish news: ${n.title}`}
      >
        {n.status === "published" ? <EyeOff size={15} /> : <CheckCircle2 size={15} />}
      </Button>
      <Button variant="ghost" size="sm" iconOnly onClick={() => setDeleting(n)} title="Delete" aria-label={`Delete news: ${n.title}`}>
        <Trash2 size={15} />
      </Button>
    </>
  );

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input
                type="text"
                placeholder="Search news by title or summary..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button type="button" className={styles.clearBtn} onClick={() => setSearch("")}>
                  <X size={14} />
                </button>
              )}
            </div>
            <Button type="submit" variant="primary" size="sm">
              <Search size={14} /> Search
            </Button>
          </form>
          <div className={styles.toolbarRight}>
            <div className={styles.filterRow}>
              <Filter size={14} />
              <SearchableSelect
                id="news-status-filter"
                variant="compact"
                label="Filter by status"
                placeholder="All Status"
                value={statusFilter}
                options={[
                  { value: "", label: "All Status" },
                  ...NEWS_STATUSES.map((s) => ({
                    value: s,
                    label: s.charAt(0).toUpperCase() + s.slice(1),
                  })),
                ]}
                triggerClassName={styles.select}
                onChange={(value) => setStatusFilter(value)}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setCreateForm(blankForm());
                setCreateError("");
                setCreateSuccess("");
                resetImageState();
                setShowCreateForm(true);
              }}
            >
              <Plus size={14} /> Add News
            </Button>
          </div>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader
          title={`News (${pagination.total})`}
          subtitle={`Page ${pagination.page} of ${pagination.totalPages || 1} · Newest first by publication date`}
        />
        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading news...</p>
          </div>
        ) : error ? (
          <ErrorState title="Unable to load news" description={error} onRetry={() => fetchNews(pagination.page)} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Newspaper />}
            title="No news found"
            description="No news records match your search. Use “Add News” to publish the first item."
          />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Image</th>
                    <th>Title</th>
                    <th>Published</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((n) => (
                    <tr key={n.id}>
                      <td>
                        {n.imageUrl ? (
                          <span className={styles.thumb}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={n.imageUrl} alt={n.imageAlt || n.title} />
                          </span>
                        ) : (
                          <span className={styles.thumbEmpty} aria-hidden="true">
                            —
                          </span>
                        )}
                      </td>
                      <td className={styles.nameCell}>
                        <span className={styles.rowTitle}>{n.title}</span>
                        {n.summary && <span className={styles.rowSummary}>{n.summary}</span>}
                      </td>
                      <td>{formatDate(n.publishedDate)}</td>
                      <td>
                        <Badge variant={getStatusVariant(n.status)}>{n.status}</Badge>
                      </td>
                      <td className={styles.actionsCell}>{renderActions(n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile only (<=600px): same array as the table above. */}
            <RecordList>
              {items.map((n) => (
                <RecordCard
                  key={n.id}
                  title={n.title}
                  subtitle={n.summary || formatDate(n.publishedDate)}
                  actions={renderActions(n)}
                >
                  <RecordField label="Published">{formatDate(n.publishedDate)}</RecordField>
                  <RecordField label="Status">
                    <Badge variant={getStatusVariant(n.status)}>{n.status}</Badge>
                  </RecordField>
                  <RecordField label="Image">
                    {n.imageUrl ? (
                      <span className={styles.recordImageWrap}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={n.imageUrl} alt={n.imageAlt || n.title} className={styles.recordImage} />
                      </span>
                    ) : (
                      "No image"
                    )}
                  </RecordField>
                </RecordCard>
              ))}
            </RecordList>

            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => fetchNews(pagination.page - 1)}
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
                  onClick={() => fetchNews(pagination.page + 1)}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Preview Modal */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} maxWidth={560}>
        {viewing && (
          <>
            <h3 className={styles.modalTitle}>News Preview</h3>
            <div className={styles.profileGrid}>
              <div className={styles.profileItemFull}>
                <span className={styles.profileLabel}>Title</span>
                <span className={styles.profileValue}>{viewing.title}</span>
              </div>
              <div className={styles.profileItem}>
                <span className={styles.profileLabel}>Status</span>
                <Badge variant={getStatusVariant(viewing.status)}>{viewing.status}</Badge>
              </div>
              <div className={styles.profileItem}>
                <span className={styles.profileLabel}>Published</span>
                <span className={styles.profileValue}>{formatDate(viewing.publishedDate)}</span>
              </div>
              {viewing.summary && (
                <div className={styles.profileItemFull}>
                  <span className={styles.profileLabel}>Summary</span>
                  <span className={styles.profileValue}>{viewing.summary}</span>
                </div>
              )}
              {viewing.imageId && (
                <div className={styles.profileItemFull}>
                  <span className={styles.profileLabel}>Featured Image</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className={styles.viewImage}
                    src={viewing.imageUrl || `/api/images/${viewing.imageId}`}
                    alt={viewing.imageAlt || viewing.title}
                  />
                  {viewing.imageAlt && (
                    <span className={styles.formHint}>Alt: {viewing.imageAlt}</span>
                  )}
                </div>
              )}
              {viewing.content && (
                <div className={styles.profileItemFull}>
                  <span className={styles.profileLabel}>Content</span>
                  <span className={styles.profileValue}>{viewing.content}</span>
                </div>
              )}
            </div>
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setViewing(null)}>
                Close
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Create Modal */}
      <Modal
        open={showCreateForm}
        onClose={() => {
          if (!createLoading) {
            setShowCreateForm(false);
            setCreateError("");
            setCreateSuccess("");
          }
        }}
        maxWidth={600}
      >
        <form onSubmit={handleCreateSubmit}>
          <h3 className={styles.modalTitle}>Add News</h3>
          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label>Title *</label>
              <input
                type="text"
                placeholder="e.g. MSU students win national hackathon"
                value={createForm.title}
                onChange={(e) => updateFormFields(setCreateForm, "title", e.target.value)}
              />
            </div>
            <div className={styles.formField}>
              <label>Heading / Summary</label>
              <textarea
                rows={2}
                placeholder="Short summary shown on text-only carousel slides..."
                value={createForm.summary}
                onChange={(e) => updateFormFields(setCreateForm, "summary", e.target.value)}
                style={textareaStyle}
              />
            </div>
            <div className={styles.formField}>
              <label>Content</label>
              <textarea
                rows={4}
                placeholder="Full news content (shown on the public news page)..."
                value={createForm.content}
                onChange={(e) => updateFormFields(setCreateForm, "content", e.target.value)}
                style={textareaStyle}
              />
            </div>
            <div className={styles.formField}>
              <label>Publication Date *</label>
              <input
                type="date"
                value={createForm.publishedDate}
                onChange={(e) => updateFormFields(setCreateForm, "publishedDate", e.target.value)}
              />
            </div>
            <div className={styles.formField}>
              <label>Status</label>
              <select
                value={createForm.status}
                onChange={(e) => updateFormFields(setCreateForm, "status", e.target.value as NewsStatus)}
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </div>
            {renderImageField(createForm, setCreateForm)}
          </div>
          {createError && <p className={styles.formError}>{createError}</p>}
          {createSuccess && <p className={styles.formSuccess}>{createSuccess}</p>}
          <div className={styles.modalActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setShowCreateForm(false);
                setCreateError("");
                setCreateSuccess("");
              }}
              disabled={createLoading}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={createLoading}>
              <UploadCloud size={14} /> Create News
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        open={showEditForm}
        onClose={() => {
          if (!editLoading) {
            setShowEditForm(false);
            setEditError("");
            setEditSuccess("");
          }
        }}
        maxWidth={600}
      >
        <form onSubmit={handleEditSubmit}>
          <h3 className={styles.modalTitle}>Edit News</h3>
          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label>Title *</label>
              <input
                type="text"
                value={editForm.title}
                onChange={(e) => updateFormFields(setEditForm, "title", e.target.value)}
              />
            </div>
            <div className={styles.formField}>
              <label>Heading / Summary</label>
              <textarea
                rows={2}
                value={editForm.summary}
                onChange={(e) => updateFormFields(setEditForm, "summary", e.target.value)}
                style={textareaStyle}
              />
            </div>
            <div className={styles.formField}>
              <label>Content</label>
              <textarea
                rows={4}
                value={editForm.content}
                onChange={(e) => updateFormFields(setEditForm, "content", e.target.value)}
                style={textareaStyle}
              />
            </div>
            <div className={styles.formField}>
              <label>Publication Date *</label>
              <input
                type="date"
                value={editForm.publishedDate}
                onChange={(e) => updateFormFields(setEditForm, "publishedDate", e.target.value)}
              />
            </div>
            <div className={styles.formField}>
              <label>Status</label>
              <select
                value={editForm.status}
                onChange={(e) => updateFormFields(setEditForm, "status", e.target.value as NewsStatus)}
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </div>
            {renderImageField(editForm, setEditForm)}
          </div>
          {editError && <p className={styles.formError}>{editError}</p>}
          {editSuccess && <p className={styles.formSuccess}>{editSuccess}</p>}
          <div className={styles.modalActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setShowEditForm(false);
                setEditError("");
                setEditSuccess("");
              }}
              disabled={editLoading}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={editLoading}>
              Update News
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => {
          if (!deleteLoading) setDeleting(null);
        }}
        onConfirm={handleDelete}
        title="Delete News"
        description={`Delete "${deleting?.title}"? It will be removed from the admin list and the public homepage. Its image is kept.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}

/** Inline textarea styling — matches the notices page's existing convention. */
const textareaStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderRadius: "8px",
  border: "1.5px solid rgba(21,97,109,0.12)",
  fontSize: "0.85rem",
  resize: "vertical",
  fontFamily: "inherit",
};
