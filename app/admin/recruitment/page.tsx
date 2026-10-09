"use client";

/**
 * Recruitment Management — CRUD for the shared `recruitments` collection.
 *
 * One page, two sections (Job Openings and Government Orders & Circulars) with
 * a tab switcher, matching the single public /recruitment page. The Admin
 * portal is the authoritative writer; the public site only reads.
 *
 * Data flow:
 *   1. GET    /api/admin/recruitment          — one section (server-side search,
 *                                               status filter, pagination) + both
 *                                               section totals
 *   2. POST   /api/admin/recruitment          — create
 *   3. PUT    /api/admin/recruitment          — update / publish / reorder
 *   4. DELETE /api/admin/recruitment          — delete (+ stored PDF)
 *   5. POST   /api/admin/syllabus/upload      — the EXISTING shared GridFS PDF
 *                                               upload (reused; no new uploader)
 *
 * Security: the JWT is attached to every request and all authorization is
 * re-checked server-side by authenticateAdmin(). The UI is never the source of
 * truth; client-side validation is only a UX courtesy.
 *
 * Documents only — there is deliberately NO image handling on this page.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Search,
  Filter,
  Eye,
  Edit3,
  ChevronLeft,
  ChevronRight,
  X,
  Plus,
  Trash2,
  EyeOff,
  CheckCircle2,
  ArrowUp,
  ArrowDown,
  Briefcase,
  FileText,
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
  RECRUITMENT_SECTIONS,
  RECRUITMENT_STATUSES,
  sectionFor,
  type RecruitmentCounts,
  type RecruitmentRecord,
  type RecruitmentStatus,
  type RecruitmentType,
} from "@/lib/recruitment-types";
import styles from "./page.module.css";

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface RecruitmentForm {
  type: RecruitmentType;
  title: string;
  description: string;
  /** `YYYY-MM-DD` for the <input type="date">. */
  publishedDate: string;
  status: RecruitmentStatus;
  displayOrder: string;
  documentUrl: string;
  documentName: string;
}

/** Today as `YYYY-MM-DD` (local date, for the form's default). */
function todayInputValue(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().split("T")[0];
}

function blankForm(type: RecruitmentType): RecruitmentForm {
  return {
    type,
    title: "",
    description: "",
    publishedDate: todayInputValue(),
    status: "draft",
    displayOrder: "0",
    documentUrl: "",
    documentName: "",
  };
}

function statusVariant(status: RecruitmentStatus): "success" | "info" {
  return status === "published" ? "success" : "info";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function AdminRecruitmentPage() {
  const [activeType, setActiveType] = useState<RecruitmentType>("job-opening");

  const [items, setItems] = useState<RecruitmentRecord[]>([]);
  const [counts, setCounts] = useState<RecruitmentCounts>({
    jobOpenings: 0,
    governmentOrders: 0,
  });
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState<RecruitmentForm>(blankForm("job-opening"));
  const [docFile, setDocFile] = useState<File | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleting, setDeleting] = useState<RecruitmentRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [rowBusyId, setRowBusyId] = useState("");

  // Monotonic request id — only the newest request may write state, so a slow
  // earlier response can never overwrite a newer (filtered) one.
  const requestSeq = useRef(0);

  const section = sectionFor(activeType);

  const fetchList = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        type: activeType,
        page: String(page),
        limit: "20",
      });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);

      const res = await fetch(`/api/admin/recruitment?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        setError("Unable to load recruitment records.");
        return;
      }
      const data = await res.json();
      if (seq !== requestSeq.current) return;
      if (data.success) {
        setItems(data.data as RecruitmentRecord[]);
        setCounts(data.counts as RecruitmentCounts);
        setPagination(data.pagination as Pagination);
      } else {
        setError(data.message || "Unable to load recruitment records.");
      }
    } catch {
      if (seq === requestSeq.current) setError("Unable to connect to server.");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [activeType, search, statusFilter, page]);

  // Fetching belongs in an effect, and the state it sets is the fetched
  // result. This is the identical pattern used by the sibling admin CRUD
  // pages (e.g. /admin/spotlight), which carry the same suppression.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchList();
  }, [fetchList]);

  // Debounce the search box so typing does not fire one request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function switchSection(type: RecruitmentType) {
    if (type === activeType) return;
    setActiveType(type);
    setPage(1);
    setSearch("");
    setSearchInput("");
    setStatusFilter("");
  }

  function updateForm<K extends keyof RecruitmentForm>(
    field: K,
    value: RecruitmentForm[K]
  ) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function openCreate() {
    setFormMode("create");
    setEditingId("");
    setForm(blankForm(activeType));
    setDocFile(null);
    resetFileInput();
    setFormError("");
    setFormSuccess("");
  }

  function openEdit(record: RecruitmentRecord) {
    setFormMode("edit");
    setEditingId(record.id);
    setForm({
      type: record.type,
      title: record.title,
      description: record.description,
      publishedDate: record.publishedDate
        ? new Date(record.publishedDate).toISOString().split("T")[0]
        : todayInputValue(),
      status: record.status,
      displayOrder: String(record.displayOrder ?? 0),
      documentUrl: record.documentUrl,
      documentName: record.documentName,
    });
    setDocFile(null);
    resetFileInput();
    setFormError("");
    setFormSuccess("");
  }

  function closeForm() {
    if (formLoading) return;
    setFormMode(null);
    setEditingId("");
    setForm(blankForm(activeType));
    setDocFile(null);
    resetFileInput();
    setFormError("");
    setFormSuccess("");
  }

  function resetFileInput() {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDocChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setDocFile(picked);
    setFormError("");
  }

  function clearDocument() {
    updateForm("documentUrl", "");
    updateForm("documentName", "");
    setDocFile(null);
    resetFileInput();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formLoading || !formMode) return;

    const title = form.title.trim();
    if (!title) {
      setFormError(`${section.titleLabel} is required.`);
      return;
    }
    if (!form.publishedDate) {
      setFormError(`${section.dateLabel} is required.`);
      return;
    }
    const orderNum = Number.parseInt(form.displayOrder, 10);
    if (!Number.isInteger(orderNum) || orderNum < 0) {
      setFormError("Display order must be zero or greater.");
      return;
    }

    const token = getStoredToken();
    if (!token) {
      setFormError("Not authenticated.");
      return;
    }

    setFormLoading(true);
    setFormError("");
    setFormSuccess("");

    try {
      // 1) A newly picked PDF is stored through the EXISTING shared upload.
      let documentUrl = form.documentUrl;
      let documentName = form.documentName;
      if (docFile) {
        const fd = new FormData();
        fd.append("file", docFile);
        const uploadRes = await fetch("/api/admin/syllabus/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const uploadData = await uploadRes.json();
        if (!uploadData.success) {
          setFormError(uploadData.message || "PDF upload failed.");
          return;
        }
        documentUrl = uploadData.pdfUrl as string;
        documentName = (uploadData.pdfName as string) ?? "";
      }

      // 2) Create or update the record.
      const body: Record<string, unknown> = {
        type: form.type,
        title,
        description: form.description.trim(),
        publishedDate: form.publishedDate,
        status: form.status,
        displayOrder: orderNum,
        documentUrl,
        documentName,
      };
      if (formMode === "edit") body.id = editingId;

      const res = await fetch("/api/admin/recruitment", {
        method: formMode === "edit" ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) {
        setFormError(data.message || "Failed to save the record.");
        return;
      }

      setFormSuccess(formMode === "edit" ? "Updated successfully!" : "Created successfully!");
      setTimeout(() => {
        setFormMode(null);
        setEditingId("");
        setForm(blankForm(activeType));
        setDocFile(null);
        resetFileInput();
        setFormError("");
        setFormSuccess("");
        fetchList();
      }, 900);
    } catch {
      setFormError("Unable to connect to server.");
    } finally {
      setFormLoading(false);
    }
  }

  async function toggleStatus(record: RecruitmentRecord) {
    if (rowBusyId) return;
    const token = getStoredToken();
    if (!token) return;
    const nextStatus: RecruitmentStatus =
      record.status === "published" ? "draft" : "published";
    setRowBusyId(record.id);
    try {
      const res = await fetch("/api/admin/recruitment", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: record.id, status: nextStatus }),
      });
      const data = await res.json();
      if (data.success) await fetchList();
    } catch {
      /* keep the current state; the next fetch resyncs */
    } finally {
      setRowBusyId("");
    }
  }

  async function move(record: RecruitmentRecord, dir: -1 | 1) {
    if (rowBusyId) return;
    const index = items.findIndex((it) => it.id === record.id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= items.length) return;

    const token = getStoredToken();
    if (!token) return;

    // Swap the two rows and persist a stable, evenly spaced order for every row
    // whose value actually changed.
    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setRowBusyId(record.id);
    try {
      await Promise.all(
        reordered.map((it, i) => {
          const newOrder = (i + 1) * 10;
          if (it.displayOrder === newOrder) return Promise.resolve();
          return fetch("/api/admin/recruitment", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ id: it.id, displayOrder: newOrder }),
          });
        })
      );
      await fetchList();
    } catch {
      await fetchList();
    } finally {
      setRowBusyId("");
    }
  }

  async function handleDelete() {
    if (!deleting || deleteLoading) return;
    setDeleteLoading(true);
    const token = getStoredToken();
    if (!token) {
      setDeleteLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/recruitment", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: deleting.id }),
      });
      const data = await res.json();
      if (data.success) {
        setDeleting(null);
        await fetchList();
      }
    } catch {
      /* keep the dialog open */
    } finally {
      setDeleteLoading(false);
    }
  }

  const renderActions = (record: RecruitmentRecord, index: number) => (
    <>
      {record.documentUrl && (
        <a
          className={styles.iconLink}
          href={record.documentUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="View PDF"
          aria-label={`View PDF for: ${record.title}`}
        >
          <Eye size={15} />
        </a>
      )}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title="Edit"
        aria-label={`Edit: ${record.title}`}
        disabled={rowBusyId === record.id}
        onClick={() => openEdit(record)}
      >
        <Edit3 size={15} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title={record.status === "published" ? "Unpublish" : "Publish"}
        aria-label={
          record.status === "published"
            ? `Unpublish: ${record.title}`
            : `Publish: ${record.title}`
        }
        disabled={rowBusyId === record.id}
        onClick={() => toggleStatus(record)}
      >
        {record.status === "published" ? <EyeOff size={15} /> : <CheckCircle2 size={15} />}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title="Move up"
        aria-label={`Move up: ${record.title}`}
        disabled={index === 0 || rowBusyId === record.id}
        onClick={() => move(record, -1)}
      >
        <ArrowUp size={15} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title="Move down"
        aria-label={`Move down: ${record.title}`}
        disabled={index === items.length - 1 || rowBusyId === record.id}
        onClick={() => move(record, 1)}
      >
        <ArrowDown size={15} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title="Delete"
        aria-label={`Delete: ${record.title}`}
        disabled={rowBusyId === record.id}
        onClick={() => setDeleting(record)}
      >
        <Trash2 size={15} />
      </Button>
    </>
  );

  const sectionCount =
    activeType === "job-opening" ? counts.jobOpenings : counts.governmentOrders;

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <div className={styles.tabs} role="tablist" aria-label="Recruitment sections">
          {RECRUITMENT_SECTIONS.map((tab) => {
            const isActive = tab.type === activeType;
            return (
              <button
                key={tab.type}
                type="button"
                role="tab"
                id={`tab-${tab.type}`}
                aria-selected={isActive}
                aria-controls="recruitment-panel"
                className={`${styles.tab} ${isActive ? styles.tabActive : ""}`}
                onClick={() => switchSection(tab.type)}
              >
                <Briefcase size={15} aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
        <p className={styles.sectionDesc}>{section.description}</p>
      </Card>

      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form
            className={styles.searchForm}
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchInput.trim());
              setPage(1);
            }}
          >
            <div className={styles.searchInput}>
              <Search size={16} />
              <input
                type="text"
                placeholder={`Search ${section.label.toLowerCase()}...`}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                aria-label={`Search ${section.label}`}
              />
              {searchInput && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => setSearchInput("")}
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </form>

          <div className={styles.toolbarRight}>
            <div className={styles.filterRow}>
              <Filter size={14} aria-hidden="true" />
              <label htmlFor="recruitment-status-filter" className={styles.srOnly}>
                Filter by status
              </label>
              <SearchableSelect
                id="recruitment-status-filter"
                variant="compact"
                label="Filter by status"
                placeholder="All Status"
                value={statusFilter}
                options={[
                  { value: "", label: "All Status" },
                  ...RECRUITMENT_STATUSES.map((s) => ({
                    value: s,
                    label: s.charAt(0).toUpperCase() + s.slice(1),
                  })),
                ]}
                triggerClassName={styles.select}
                onChange={(value) => {
                  setStatusFilter(value);
                  setPage(1);
                }}
              />
            </div>
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus size={14} /> Add {activeType === "job-opening" ? "Job Opening" : "Government Order"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader
          title={`${section.label} (${sectionCount})`}
          subtitle={`${sectionCount} ${sectionCount === 1 ? "record" : "records"} · ${
            pagination.total
          } matching ${search || statusFilter ? "the current filters" : "this section"}`}
        />

        <div
          id="recruitment-panel"
          role="tabpanel"
          aria-labelledby={`tab-${activeType}`}
        >
          {loading ? (
            <div className={styles.loadingState} role="status">
              <div className={styles.spinner} />
              <p>Loading recruitment records...</p>
            </div>
          ) : error ? (
            <ErrorState
              title="Unable to load recruitment records"
              description={error}
              onRetry={fetchList}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title={search || statusFilter ? "No matching records" : section.emptyTitle}
              description={
                search || statusFilter
                  ? "No records match the current search or filter. Try clearing them."
                  : section.emptyDescription
              }
            />
          ) : (
            <>
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>{section.titleLabel}</th>
                      <th>{section.dateLabel}</th>
                      <th>Status</th>
                      <th>Order</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((record, index) => (
                      <tr key={record.id}>
                        <td className={styles.nameCell}>
                          <span className={styles.rowTitle}>{record.title}</span>
                          {record.description && (
                            <span className={styles.rowSummary}>{record.description}</span>
                          )}
                        </td>
                        <td>{formatDate(record.publishedDate)}</td>
                        <td>
                          <Badge variant={statusVariant(record.status)}>
                            {record.status}
                          </Badge>
                        </td>
                        <td>
                          <span className={styles.orderCell}>#{record.displayOrder}</span>
                        </td>
                        <td className={styles.actionsCell}>
                          {renderActions(record, index)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile only (<=600px): same array as the table above. */}
              <RecordList>
                {items.map((record, index) => (
                  <RecordCard
                    key={record.id}
                    title={record.title}
                    subtitle={record.description || formatDate(record.publishedDate)}
                    actions={renderActions(record, index)}
                  >
                    <RecordField label={section.dateLabel}>
                      {formatDate(record.publishedDate)}
                    </RecordField>
                    <RecordField label="Status">
                      <Badge variant={statusVariant(record.status)}>
                        {record.status}
                      </Badge>
                    </RecordField>
                    <RecordField label="Order">#{record.displayOrder}</RecordField>
                    <RecordField label="Document">
                      {record.documentUrl ? (
                        <a
                          className={styles.docLink}
                          href={record.documentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {record.documentName || "View PDF"}
                        </a>
                      ) : (
                        "No document"
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
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
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
                    onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                  >
                    Next <ChevronRight size={14} />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {/* Create / Edit modal */}
      <Modal
        open={formMode !== null}
        onClose={closeForm}
        maxWidth={600}
      >
        <form onSubmit={handleSubmit}>
          <h3 className={styles.modalTitle}>
            {formMode === "edit"
              ? `Edit ${activeType === "job-opening" ? "Job Opening" : "Government Order"}`
              : `Add ${activeType === "job-opening" ? "Job Opening" : "Government Order"}`}
          </h3>
          <p className={styles.modalDesc}>
            Published records appear on the public Recruitment page.
          </p>

          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="recruitment-title">{section.titleLabel} *</label>
              <input
                id="recruitment-title"
                type="text"
                maxLength={200}
                placeholder={section.titlePlaceholder}
                value={form.title}
                onChange={(e) => updateForm("title", e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="recruitment-description">Description</label>
              <textarea
                id="recruitment-description"
                rows={3}
                maxLength={1000}
                placeholder="Short summary shown under the title (optional)."
                value={form.description}
                onChange={(e) => updateForm("description", e.target.value)}
                className={styles.textarea}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="recruitment-date">{section.dateLabel} *</label>
              <input
                id="recruitment-date"
                type="date"
                value={form.publishedDate}
                onChange={(e) => updateForm("publishedDate", e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="recruitment-status">Status</label>
              <select
                id="recruitment-status"
                value={form.status}
                onChange={(e) =>
                  updateForm("status", e.target.value as RecruitmentStatus)
                }
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </div>

            <div className={styles.formField}>
              <label htmlFor="recruitment-order">Display Order</label>
              <input
                id="recruitment-order"
                type="number"
                min={0}
                step={1}
                value={form.displayOrder}
                onChange={(e) => updateForm("displayOrder", e.target.value)}
              />
              <span className={styles.formHint}>Lower numbers appear first.</span>
            </div>

            <div className={styles.formField}>
              <label htmlFor="recruitment-document">PDF Document</label>
              {(form.documentUrl || docFile) && (
                <span className={styles.docCurrent}>
                  <FileText size={15} aria-hidden="true" />
                  {docFile ? docFile.name : form.documentName || "Current document"}
                  {form.documentUrl && !docFile && (
                    <a
                      className={styles.docLink}
                      href={form.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View
                    </a>
                  )}
                  <button
                    type="button"
                    className={styles.docRemove}
                    onClick={clearDocument}
                  >
                    Remove
                  </button>
                </span>
              )}
              <input
                id="recruitment-document"
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={handleDocChange}
              />
              <span className={styles.formHint}>
                PDF only, up to 10 MB. Leave empty to keep the current document.
              </span>
            </div>
          </div>

          {formError && <p className={styles.formError}>{formError}</p>}
          {formSuccess && <p className={styles.formSuccess}>{formSuccess}</p>}

          <div className={styles.modalActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={closeForm}
              disabled={formLoading}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={formLoading}>
              {formMode === "edit" ? "Update" : "Create"}
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
        title="Delete Recruitment Record"
        description={`Delete "${deleting?.title}"? It will be removed from the admin list and the public Recruitment page, and its stored PDF will be deleted too.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
