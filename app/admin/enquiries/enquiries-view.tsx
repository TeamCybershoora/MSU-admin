"use client";

/**
 * Enquiry Management view — the Admin Portal's view of the enquiries submitted
 * through the PUBLIC MSU website's Contact page.
 *
 * ONE shared implementation behind every enquiry page; the `fixedType` prop
 * scopes every list request to a single enquiry type, so a page can only ever
 * show its own submissions:
 *   /admin/enquiries/admission            → fixedType="admission"
 *   /admin/enquiries/college-registration → fixedType="affiliation"
 *   /admin/enquiries/general              → fixedType="general"
 *
 * The general page additionally exposes three SEPARATE tools:
 *   - Inquiry Type — the topic the PUBLIC submitter chose (a stored field);
 *   - Category — a keyword search over enquiry content (query-time only);
 *   - Classification — the optional value an admin SAVES on one enquiry.
 * None is derived from another, and keyword matching never writes a value:
 * `inquiryType` is the public user's choice, `classification` the admin's.
 *
 * Features:
 * - Paginated table with search (reference, email, phone, name, college) and
 *   a status filter (the enquiry type is fixed by the page)
 * - Full detail modal: reference, type, contact details, type-specific fields,
 *   the submitter's message and timestamps
 * - Status workflow control offering only the transitions the server allows
 * - Reply composer that emails the SUBMITTER'S OWN stored address
 * - Per-enquiry audit history (views, status changes, replies, deletion)
 * - Delete with an explicit confirmation naming the enquiry reference
 *
 * Data flow:
 *   1. GET    /api/admin/enquiries?type=X   — list (paged; the type filter is
 *                                              always sent and server-validated)
 *   2. GET    /api/admin/enquiries/{ref}     — detail + audit history
 *   3. PATCH  /api/admin/enquiries/{ref}     — status transition
 *   4. POST   /api/admin/enquiries/{ref}/reply — send the reply email
 *   5. DELETE /api/admin/enquiries/{ref}     — permanent removal
 *
 * Security / privacy:
 * - Every call sends the admin JWT; every endpoint re-checks authentication and
 *   authorization SERVER-side (hiding a button is never the control).
 * - The list shows only masked contact information. The full email, phone,
 *   address and message are fetched per-enquiry, and that read is audited.
 * - The reply recipient is never sent from this page: the server always uses the
 *   enquiry's stored email address.
 * - Enquiries are identified throughout the UI by their human reference
 *   (MSU-ENQ-XXXXXXXX); MongoDB ids never reach the browser.
 *
 * Enquiry types, statuses and labels come from @/lib/enquiry-types (single
 * source of truth), and the status transition rules from
 * @/lib/enquiry-validation — the same module the server enforces with.
 *
 * Server-side note: list filtering by type happens in the API (validated by
 * parseEnquiryTypeFilter), never here. This view additionally refuses to open
 * a detail whose stored type does not match `fixedType` as defence in depth —
 * every record operation is keyed by the server-validated reference anyway.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Eye,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Mail,
  Send,
  X,
  Clock,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog, ModalScrollable } from "@/components/ui/modal";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import {
  ENQUIRY_STATUSES,
  GENERAL_INQUIRY_TYPES,
  GENERAL_INQUIRY_TYPE_LABELS,
  INQUIRY_TYPE_UNSPECIFIED,
  generalInquiryTypeLabel,
  type EnquiryStatus,
  type EnquiryType,
} from "@/lib/enquiry-types";
import {
  ENQUIRY_CATEGORIES,
  GENERAL_CLASSIFICATIONS,
  GENERAL_CLASSIFICATION_LABELS,
  generalClassificationLabel,
} from "@/lib/enquiry-categories";
import {
  ENQUIRY_REPLY_MAX_LENGTH,
  ENQUIRY_REPLY_MIN_LENGTH,
  allowedTransitions,
  canReplyFrom,
} from "@/lib/enquiry-validation";
import styles from "./page.module.css";

/* ── API payload shapes ──────────────────────────────────────── */

interface EnquiryRow {
  reference: string;
  type: EnquiryType;
  status: EnquiryStatus;
  createdAt: string | null;
  contactName: string;
  organisation: string;
  emailMasked: string;
  /** "" means unclassified (only meaningful for general enquiries). */
  classification: string;
  /** Public submitter's chosen topic; "" means unspecified (legacy record). */
  inquiryType: string;
}

interface EnquiryDetail {
  reference: string;
  type: EnquiryType;
  status: EnquiryStatus;
  email: string;
  phone: string;
  message: string;
  fullName: string;
  course: string;
  session: string;
  collegeName: string;
  contactPerson: string;
  designation: string;
  address: string;
  district: string;
  collegeType: string;
  purpose: string;
  courses: string;
  inquiryType: string;
  generalClassification: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface AuditEntry {
  action: string;
  previousStatus: string;
  newStatus: string;
  metadata: string;
  actorName: string;
  createdAt: string | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/* ── Presentation helpers ────────────────────────────────────── */

const STATUS_LABELS: Record<EnquiryStatus, string> = {
  new: "New",
  in_review: "In Review",
  responded: "Responded",
  closed: "Closed",
};

const TYPE_LABELS: Record<EnquiryType, string> = {
  admission: "Admission",
  affiliation: "College Registration / Affiliation",
  general: "General",
};

type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

function getStatusVariant(status: EnquiryStatus | string): BadgeVariant {
  switch (status) {
    case "new":
      return "info";
    case "in_review":
      return "warning";
    case "responded":
      return "success";
    case "closed":
      return "neutral";
    default:
      return "neutral";
  }
}

/** Readable label for a stored status value (tolerates legacy/empty values). */
function statusLabel(value: string): string {
  return STATUS_LABELS[value as EnquiryStatus] ?? (value || "—");
}

function typeLabel(value: EnquiryType | string): string {
  return TYPE_LABELS[value as EnquiryType] ?? (value || "—");
}

/**
 * Provider-independent explanation of a failed reply.
 * Raw reason tokens and provider detail are never shown to the browser.
 */
function failureReasonLabel(token: string): string {
  switch (token) {
    case "disabled":
      return "Email sending is disabled on the server.";
    // Current SMTP configuration tokens.
    case "missing_host":
    case "missing_port":
    case "invalid_port":
    case "missing_user":
    case "missing_pass":
    case "missing_from":
    case "invalid_from":
    case "invalid_reply_to":
      return "Email is not configured correctly on the server.";
    case "smtp_rejected":
      return "The mail server rejected the message.";
    case "timeout":
      return "The mail server did not respond in time.";
    case "smtp_error":
      return "The mail server could not be reached.";
    // Legacy tokens from older audit records (pre-SMTP provider).
    case "missing_api_key":
    case "provider_rejected":
    case "provider_error":
      return "Email is not configured correctly on the server.";
    default:
      return "The reply could not be sent.";
  }
}

/** Human-readable line pair for one audit event. */
function auditLines(entry: AuditEntry): { title: string; detail: string } {
  switch (entry.action) {
    case "enquiry.viewed":
      return { title: "Enquiry opened", detail: "Full details viewed" };
    case "enquiry.status_changed":
      return {
        title: "Status changed",
        detail: `${statusLabel(entry.previousStatus)} → ${statusLabel(entry.newStatus)}`,
      };
    case "enquiry.classification_changed": {
      // metadata is stored as "<from>-><to>" slugs ("unclassified" when empty).
      const [from, to] = entry.metadata.split("->");
      return {
        title: "Classification changed",
        detail:
          from !== undefined && to !== undefined
            ? `${generalClassificationLabel(from)} → ${generalClassificationLabel(to)}`
            : "Classification updated",
      };
    }
    case "enquiry.reply_sent":
      return {
        title: "Reply sent",
        detail:
          entry.previousStatus && entry.previousStatus !== entry.newStatus
            ? `${statusLabel(entry.previousStatus)} → ${statusLabel(entry.newStatus)}`
            : "Accepted by the mail server",
      };
    case "enquiry.reply_failed":
      return { title: "Reply failed", detail: failureReasonLabel(entry.metadata) };
    case "enquiry.deleted":
      return { title: "Enquiry deleted", detail: "" };
    default:
      return { title: entry.action, detail: "" };
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ── Page ────────────────────────────────────────────────────── */

export default function EnquiriesView({
  fixedType,
}: {
  /** The one enquiry type this page is allowed to list. */
  fixedType: EnquiryType;
}) {
  // General enquiries get three extra, clearly separated tools: the PUBLIC
  // submitter's stored Inquiry Type, a KEYWORD category filter (query-time
  // only) and the OPTIONAL saved classification. Admission and affiliation
  // pages render exactly as before.
  const isGeneral = fixedType === "general";

  const [enquiries, setEnquiries] = useState<EnquiryRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  /** Keyword category filter (general only) — never a stored value. */
  const [categoryFilter, setCategoryFilter] = useState("");
  /** PUBLIC submitter's stored topic (general only) — slug | "unspecified". */
  const [inquiryTypeFilter, setInquiryTypeFilter] = useState("");
  /** SAVED classification filter (general only) — "unclassified" | slug | "". */
  const [classificationFilter, setClassificationFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* ── Detail modal ─────────────────────────────────── */
  const [detailOpenFor, setDetailOpenFor] = useState("");
  const [detail, setDetail] = useState<EnquiryDetail | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  /* ── Status change ────────────────────────────────── */
  const [statusChoice, setStatusChoice] = useState("");
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [statusSuccess, setStatusSuccess] = useState("");

  /* ── Classification (general only) ────────────────── */
  const [classificationChoice, setClassificationChoice] = useState("");
  const [classificationLoading, setClassificationLoading] = useState(false);
  const [classificationError, setClassificationError] = useState("");
  const [classificationSuccess, setClassificationSuccess] = useState("");

  /* ── Reply ────────────────────────────────────────── */
  const [replyMessage, setReplyMessage] = useState("");
  const [replyLoading, setReplyLoading] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [replySuccess, setReplySuccess] = useState("");

  /* ── Delete ───────────────────────────────────────── */
  const [deleting, setDeleting] = useState<EnquiryRow | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  /* ── List ─────────────────────────────────────────── */

  const fetchEnquiries = useCallback(
    async (page = 1) => {
      const token = getStoredToken();
      if (!token) return;

      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({
          page: page.toString(),
          limit: "20",
          // ALWAYS sent: the server-side type filter is what separates the
          // enquiry lists — this page never shows another type.
          type: fixedType,
        });
        if (search) params.set("search", search);
        if (statusFilter) params.set("status", statusFilter);
        // Stored topic + keyword category + saved classification are three
        // DIFFERENT filters; the server combines them (and paginates the
        // filtered set) in buildEnquiryListQuery().
        if (isGeneral && inquiryTypeFilter) {
          params.set("inquiryType", inquiryTypeFilter);
        }
        if (isGeneral && categoryFilter) params.set("category", categoryFilter);
        if (isGeneral && classificationFilter) {
          params.set("classification", classificationFilter);
        }

        const res = await fetch(`/api/admin/enquiries?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          setError("Unable to load enquiries. Please try again.");
          return;
        }

        const data = await res.json();
        if (data.success) {
          setEnquiries(data.data);
          setPagination(data.pagination);
        } else {
          setError("Unable to load enquiries. Please try again.");
        }
      } catch {
        setError("Unable to load enquiries. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [search, statusFilter, inquiryTypeFilter, categoryFilter, classificationFilter, fixedType, isGeneral]
  );

  // This effect is the ONE place list requests are issued from: every filter
  // above is a useCallback dependency, so changing any of them produces a new
  // callback and refetches page 1 with the CURRENT state.
  //
  // Deliberately NOT duplicated elsewhere: a request fired straight after
  // `setState` would close over the PREVIOUS filter, and with two requests in
  // flight and no ordering guard the stale (unfiltered) response could land
  // last and overwrite the filtered one — which reads as "the filter does not
  // work". One request per change, always built from fresh state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchEnquiries(1); }, [fetchEnquiries]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchEnquiries(1);
  }

  /**
   * Apply a select filter. The refetch happens in the effect above — see the
   * note there for why this must NOT also fire its own request.
   */
  function applyFilter(setter: (value: string) => void, value: string) {
    setter(value);
  }

  /* ── Detail ───────────────────────────────────────── */

  const loadDetail = useCallback(async (reference: string) => {
    const token = getStoredToken();
    if (!token || !reference) return;

    setDetailLoading(true);
    setDetailError("");

    try {
      const res = await fetch(
        `/api/admin/enquiries/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!res.ok) {
        setDetailError("Unable to load this enquiry. Please try again.");
        return;
      }

      const data = await res.json();
      if (data.success) {
        // Defence in depth: only an enquiry of THIS page's type may be opened
        // here. The list is already filtered server-side, so a mismatch means
        // something is wrong — surface it instead of rendering another
        // category's data (and its status/reply controls) on this page.
        if (data.data.enquiry?.type !== fixedType) {
          setDetailError(
            "This enquiry does not belong to this list. Close this window and refresh the page."
          );
          return;
        }
        setDetail(data.data.enquiry);
        setClassificationChoice(
          data.data.enquiry.generalClassification ?? ""
        );
        setAuditLog(data.data.auditLog ?? []);
      } else {
        setDetailError("Unable to load this enquiry. Please try again.");
      }
    } catch {
      setDetailError("Unable to load this enquiry. Please try again.");
    } finally {
      setDetailLoading(false);
    }
  }, [fixedType]);

  function openDetail(row: EnquiryRow) {
    setDetailOpenFor(row.reference);
    setDetail(null);
    setAuditLog([]);
    setDetailError("");
    setStatusChoice("");
    setStatusError("");
    setStatusSuccess("");
    setClassificationChoice("");
    setClassificationError("");
    setClassificationSuccess("");
    setReplyMessage("");
    setReplyError("");
    setReplySuccess("");
    void loadDetail(row.reference);
  }

  function closeDetail() {
    if (statusLoading || replyLoading || classificationLoading) return;
    setDetailOpenFor("");
    setDetail(null);
    setAuditLog([]);
    setStatusChoice("");
    setStatusError("");
    setStatusSuccess("");
    setClassificationChoice("");
    setClassificationError("");
    setClassificationSuccess("");
    setReplyMessage("");
    setReplyError("");
    setReplySuccess("");
  }

  /* ── Status change ────────────────────────────────── */

  async function handleStatusUpdate() {
    if (!detail || !statusChoice || statusLoading) return;

    const token = getStoredToken();
    if (!token) return;

    setStatusLoading(true);
    setStatusError("");
    setStatusSuccess("");

    try {
      const res = await fetch(
        `/api/admin/enquiries/${encodeURIComponent(detail.reference)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: statusChoice }),
        }
      );

      const data = await res.json();

      if (!data.success) {
        setStatusError(data.message || "Unable to update the enquiry status.");
        return;
      }

      setStatusSuccess("Status updated successfully.");
      setStatusChoice("");
      await loadDetail(detail.reference);
      fetchEnquiries(pagination.page);
    } catch {
      setStatusError("Unable to update the enquiry status.");
    } finally {
      setStatusLoading(false);
    }
  }

  /* ── Classification change (general only) ─────────── */

  async function handleClassificationUpdate() {
    if (!detail || classificationLoading) return;

    const token = getStoredToken();
    if (!token) return;

    setClassificationLoading(true);
    setClassificationError("");
    setClassificationSuccess("");

    try {
      const res = await fetch(
        `/api/admin/enquiries/${encodeURIComponent(detail.reference)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          // The value is validated server-side against the allowed list; this
          // control only offers those values. Keyword category filters never
          // write here.
          body: JSON.stringify({ classification: classificationChoice }),
        }
      );

      const data = await res.json();

      if (!data.success) {
        setClassificationError(
          data.message || "Unable to update the classification."
        );
        return;
      }

      setClassificationSuccess("Classification updated successfully.");
      await loadDetail(detail.reference);
      fetchEnquiries(pagination.page);
    } catch {
      setClassificationError("Unable to update the classification.");
    } finally {
      setClassificationLoading(false);
    }
  }

  /* ── Reply ────────────────────────────────────────── */

  async function handleSendReply() {
    if (!detail || replyLoading) return;

    const message = replyMessage.trim();
    if (message.length < ENQUIRY_REPLY_MIN_LENGTH) {
      setReplyError(
        `Reply message must be at least ${ENQUIRY_REPLY_MIN_LENGTH} characters.`
      );
      return;
    }

    const token = getStoredToken();
    if (!token) return;

    setReplyLoading(true);
    setReplyError("");
    setReplySuccess("");

    try {
      const res = await fetch(
        `/api/admin/enquiries/${encodeURIComponent(detail.reference)}/reply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          // The recipient is NOT sent: the server always replies to the
          // enquiry's own stored email address.
          body: JSON.stringify({ message }),
        }
      );

      const data = await res.json();

      if (!data.success) {
        setReplyError(data.message || "Unable to send reply. Please try again.");
        // A failed attempt is still audited server-side; refresh so the failure
        // shows up in the history and the admin can retry.
        await loadDetail(detail.reference);
        return;
      }

      setReplySuccess("Reply sent successfully.");
      setReplyMessage("");
      await loadDetail(detail.reference);
      fetchEnquiries(pagination.page);
    } catch {
      setReplyError("Unable to send reply. Please try again.");
    } finally {
      setReplyLoading(false);
    }
  }

  /* ── Delete ───────────────────────────────────────── */

  async function handleDelete() {
    if (!deleting || deleteLoading) return;

    const token = getStoredToken();
    if (!token) return;

    setDeleteLoading(true);
    setDeleteError("");

    try {
      const res = await fetch(
        `/api/admin/enquiries/${encodeURIComponent(deleting.reference)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const data = await res.json();

      if (!data.success) {
        // Close the dialog and surface the failure on the page: the confirmation
        // dialog has no slot for an inline error, and silently swallowing the
        // failure (as a delete-only flow might) would leave the row looking
        // deleted when it is not.
        setDeleting(null);
        setDeleteError(data.message || "Unable to delete the enquiry.");
        return;
      }

      if (detailOpenFor === deleting.reference) {
        setDetailOpenFor("");
        setDetail(null);
        setAuditLog([]);
      }
      setDeleting(null);
      fetchEnquiries(pagination.page);
    } catch {
      setDeleting(null);
      setDeleteError("Unable to delete the enquiry.");
    } finally {
      setDeleteLoading(false);
    }
  }

  /* ── Render ───────────────────────────────────────── */

  const transitions = detail ? allowedTransitions(detail.status) : [];
  const replyAllowed = detail ? canReplyFrom(detail.status) : false;
  const replyTooShort =
    replyMessage.trim().length < ENQUIRY_REPLY_MIN_LENGTH;

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input
                type="text"
                placeholder={
                  isGeneral
                    ? "Search enquiries by reference, name, email or message..."
                    : "Search by reference, email, phone or name..."
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => {
                    setSearch("");
                    // The effect refetches with the cleared term — never fire
                    // a request from a stale closure here.
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <Button type="submit" variant="primary" size="sm">
              <Search size={14} /> Search
            </Button>
          </form>

          <div className={styles.toolbarRight}>
            {/* General only: INQUIRY TYPE is the topic the PUBLIC submitter
                chose — read from the stored field by the server. */}
            {isGeneral && (
              <select
                value={inquiryTypeFilter}
                onChange={(e) => applyFilter(setInquiryTypeFilter, e.target.value)}
                className={styles.select}
                aria-label="Filter by inquiry type"
              >
                <option value="">All Inquiry Types</option>
                {GENERAL_INQUIRY_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {GENERAL_INQUIRY_TYPE_LABELS[value]}
                  </option>
                ))}
                <option value={INQUIRY_TYPE_UNSPECIFIED}>Unspecified</option>
              </select>
            )}

            {/* General only: CATEGORY is a keyword search over the enquiry's
                content. It is query-time only and never classifies anything. */}
            {isGeneral && (
              <select
                value={categoryFilter}
                onChange={(e) => applyFilter(setCategoryFilter, e.target.value)}
                className={styles.select}
                aria-label="Filter by category"
              >
                <option value="">All Categories</option>
                {ENQUIRY_CATEGORIES.map((category) => (
                  <option key={category.key} value={category.key}>
                    {category.label}
                  </option>
                ))}
              </select>
            )}

            {/* General only: CLASSIFICATION reads what an admin explicitly
                saved on the enquiry — the separate "saved" concept. */}
            {isGeneral && (
              <select
                value={classificationFilter}
                onChange={(e) =>
                  applyFilter(setClassificationFilter, e.target.value)
                }
                className={styles.select}
                aria-label="Filter by saved classification"
              >
                <option value="">All Classifications</option>
                <option value="unclassified">Unclassified</option>
                {GENERAL_CLASSIFICATIONS.map((value) => (
                  <option key={value} value={value}>
                    {GENERAL_CLASSIFICATION_LABELS[value]}
                  </option>
                ))}
              </select>
            )}

            <select
              value={statusFilter}
              onChange={(e) => applyFilter(setStatusFilter, e.target.value)}
              className={styles.select}
            >
              <option value="">All Status</option>
              {ENQUIRY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader
          title={`Enquiries (${pagination.total})`}
          subtitle={`Page ${pagination.page} of ${pagination.totalPages || 1}`}
        />

        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading enquiries...</p>
          </div>
        ) : error ? (
          <ErrorState
            title="Unable to load enquiries"
            description={error}
            onRetry={() => fetchEnquiries(pagination.page)}
          />
        ) : enquiries.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title="No enquiries found"
            description={
              search ||
              statusFilter ||
              inquiryTypeFilter ||
              categoryFilter ||
              classificationFilter
                ? "No enquiries match your search or filters."
                : "Enquiries submitted through the website will appear here."
            }
          />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Submitted By</th>
                    <th>Submitted</th>
                    {isGeneral && <th>Inquiry Type</th>}
                    {isGeneral && <th>Topic</th>}
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {enquiries.map((enquiry, index) => (
                    <tr key={`${enquiry.reference || "enquiry"}-${index}`}>
                      <td className={styles.monoCell}>
                        {enquiry.reference || "—"}
                      </td>
                      <td>
                        <div className={styles.nameCell}>
                          {enquiry.contactName || "—"}
                        </div>
                        {enquiry.organisation && (
                          <div className={styles.collegeCell}>
                            {enquiry.organisation}
                          </div>
                        )}
                        <div className={styles.mutedCell}>
                          {enquiry.emailMasked}
                        </div>
                      </td>
                      <td className={styles.mutedCell}>
                        {formatDateTime(enquiry.createdAt)}
                      </td>
                      {isGeneral && (
                        <td>{generalInquiryTypeLabel(enquiry.inquiryType)}</td>
                      )}
                      {isGeneral && (
                        <td>
                          <Badge variant="neutral">
                            {generalClassificationLabel(enquiry.classification)}
                          </Badge>
                        </td>
                      )}
                      <td>
                        <Badge variant={getStatusVariant(enquiry.status)}>
                          {statusLabel(enquiry.status)}
                        </Badge>
                      </td>
                      <td className={styles.actionsCell}>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="View details"
                          disabled={!enquiry.reference}
                          onClick={() => openDetail(enquiry)}
                        >
                          <Eye size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="Delete enquiry"
                          disabled={!enquiry.reference}
                          onClick={() => {
                            setDeleteError("");
                            setDeleting(enquiry);
                          }}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile only (<=600px): same enquiries array as the table above,
                rendered as record cards. Hidden on desktop/tablet.
                The affiliation variant leads with the college name (the
                organisation field); admission leads with the applicant. */}
            <RecordList>
              {enquiries.map((enquiry, index) => {
                const isAffiliation = fixedType === "affiliation";
                const title = isAffiliation
                  ? enquiry.organisation || enquiry.contactName || "—"
                  : enquiry.contactName || enquiry.emailMasked || "—";
                const secondary = isAffiliation ? enquiry.contactName : enquiry.organisation;
                const secondaryLabel = isAffiliation ? "Contact person" : "Organisation";
                return (
                  <RecordCard
                    key={`${enquiry.reference || "enquiry"}-card-${index}`}
                    title={title}
                    subtitle={enquiry.reference || "—"}
                    actions={
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="View details"
                          aria-label={`View details for ${title}`}
                          disabled={!enquiry.reference}
                          onClick={() => openDetail(enquiry)}
                        >
                          <Eye size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="Delete enquiry"
                          aria-label={`Delete enquiry ${enquiry.reference || ""}`}
                          disabled={!enquiry.reference}
                          onClick={() => {
                            setDeleteError("");
                            setDeleting(enquiry);
                          }}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </>
                    }
                  >
                    {secondary && secondary !== title && (
                      <RecordField label={secondaryLabel}>{secondary}</RecordField>
                    )}
                    <RecordField label="Email">{enquiry.emailMasked || "—"}</RecordField>
                    {isGeneral && (
                      <RecordField label="Inquiry Type">
                        {generalInquiryTypeLabel(enquiry.inquiryType)}
                      </RecordField>
                    )}
                    {isGeneral && (
                      <RecordField label="Topic">
                        {generalClassificationLabel(enquiry.classification)}
                      </RecordField>
                    )}
                    <RecordField label="Submitted">{formatDateTime(enquiry.createdAt)}</RecordField>
                    <RecordField label="Status">
                      <Badge variant={getStatusVariant(enquiry.status)}>
                        {statusLabel(enquiry.status)}
                      </Badge>
                    </RecordField>
                  </RecordCard>
                );
              })}
            </RecordList>

            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => fetchEnquiries(pagination.page - 1)}
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
                  onClick={() => fetchEnquiries(pagination.page + 1)}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Detail modal ─────────────────────────────────── */}
      <Modal open={!!detailOpenFor} onClose={closeDetail} maxWidth={680}>
        <h3 className={styles.modalTitle}>Enquiry Details</h3>

        {detailLoading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading enquiry...</p>
          </div>
        ) : detailError ? (
          <ErrorState
            title="Unable to load enquiry"
            description={detailError}
            onRetry={() => loadDetail(detailOpenFor)}
          />
        ) : detail ? (
          <ModalScrollable>
            <span className={styles.referenceChip}>{detail.reference}</span>

            <div className={styles.badgeRow}>
              <Badge variant={detail.type === "affiliation" ? "info" : "neutral"}>
                {typeLabel(detail.type)}
              </Badge>
              <Badge variant={getStatusVariant(detail.status)}>
                {statusLabel(detail.status)}
              </Badge>
              {detail.type === "general" && (
                <Badge variant="neutral">
                  {generalClassificationLabel(detail.generalClassification)}
                </Badge>
              )}
            </div>

            {/* Submitter / contact information */}
            <div className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>Contact Information</p>
              <div className={styles.profileGrid}>
                {detail.type === "general" && (
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>Name</span>
                    <span className={styles.profileValue}>
                      {detail.fullName || "—"}
                    </span>
                  </div>
                )}
                {/* Read-only: chosen by the public submitter, so the Admin
                    never edits it. Distinct from the classification below. */}
                {detail.type === "general" && (
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>Inquiry Type</span>
                    <span className={styles.profileValue}>
                      {generalInquiryTypeLabel(detail.inquiryType)}
                    </span>
                  </div>
                )}
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Email</span>
                  <span className={styles.profileValue}>{detail.email}</span>
                </div>
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Phone</span>
                  <span className={styles.profileValue}>{detail.phone}</span>
                </div>
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Submitted</span>
                  <span className={styles.profileValue}>
                    {formatDateTime(detail.createdAt)}
                  </span>
                </div>
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Last Updated</span>
                  <span className={styles.profileValue}>
                    {formatDateTime(detail.updatedAt)}
                  </span>
                </div>
              </div>
            </div>

            {/* Type-specific information. A general (Contact Us) enquiry has no
                type-specific fields — its content is the message below. */}
            {detail.type !== "general" && (
            <div className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>
                {detail.type === "affiliation"
                  ? "College Registration / Affiliation"
                  : "Admission Details"}
              </p>
              {detail.type === "affiliation" ? (
                <div className={styles.profileGrid}>
                  <div className={styles.profileItemFull}>
                    <span className={styles.profileLabel}>
                      College / Institution
                    </span>
                    <span className={styles.profileValue}>
                      {detail.collegeName || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>Contact Person</span>
                    <span className={styles.profileValue}>
                      {detail.contactPerson || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>Designation</span>
                    <span className={styles.profileValue}>
                      {detail.designation || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>District</span>
                    <span className={styles.profileValue}>
                      {detail.district || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>College Type</span>
                    <span className={styles.profileValue}>
                      {detail.collegeType || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItemFull}>
                    <span className={styles.profileLabel}>Address</span>
                    <span className={styles.profileValue}>
                      {detail.address || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItemFull}>
                    <span className={styles.profileLabel}>Purpose</span>
                    <span className={styles.profileValue}>
                      {detail.purpose || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItemFull}>
                    <span className={styles.profileLabel}>
                      Courses / Programmes Offered
                    </span>
                    <span className={styles.profileValue}>
                      {detail.courses || "—"}
                    </span>
                  </div>
                </div>
              ) : (
                <div className={styles.profileGrid}>
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>Full Name</span>
                    <span className={styles.profileValue}>
                      {detail.fullName || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>
                      Course / Programme
                    </span>
                    <span className={styles.profileValue}>
                      {detail.course || "—"}
                    </span>
                  </div>
                  <div className={styles.profileItem}>
                    <span className={styles.profileLabel}>
                      Admission Session
                    </span>
                    <span className={styles.profileValue}>
                      {detail.session || "—"}
                    </span>
                  </div>
                </div>
              )}
            </div>
            )}

            {/* Message */}
            <div className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>Message</p>
              <div className={styles.messageBlock}>{detail.message}</div>
            </div>

            {/* Status workflow */}
            <div className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>Status</p>
              <div className={styles.statusControl}>
                <select
                  className={styles.select}
                  value={statusChoice}
                  onChange={(e) => setStatusChoice(e.target.value)}
                  disabled={statusLoading || transitions.length === 0}
                >
                  <option value="">
                    {transitions.length === 0
                      ? "No transitions available"
                      : "Select new status..."}
                  </option>
                  {transitions.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  size="sm"
                  loading={statusLoading}
                  disabled={!statusChoice}
                  onClick={handleStatusUpdate}
                >
                  Update Status
                </Button>
                <span className={styles.fieldNote}>
                  Currently: {statusLabel(detail.status)}
                </span>
              </div>
              {statusError && (
                <p className={styles.formError} style={{ marginTop: "0.75rem" }}>
                  {statusError}
                </p>
              )}
              {statusSuccess && (
                <p
                  className={styles.formSuccess}
                  style={{ marginTop: "0.75rem" }}
                >
                  {statusSuccess}
                </p>
              )}
            </div>

            {/* Classification — OPTIONAL, general enquiries only.
                Distinct from the Category filter: this value is saved; the
                filter only searches. Keyword matching never writes here. */}
            {detail.type === "general" && (
              <div className={styles.detailSection}>
                <p className={styles.detailSectionTitle}>
                  Classification (optional)
                </p>
                <div className={styles.statusControl}>
                  <select
                    className={styles.select}
                    value={classificationChoice}
                    onChange={(e) => {
                      setClassificationChoice(e.target.value);
                      setClassificationError("");
                      setClassificationSuccess("");
                    }}
                    disabled={classificationLoading}
                    aria-label="Saved classification"
                  >
                    <option value="">Unclassified</option>
                    {GENERAL_CLASSIFICATIONS.map((value) => (
                      <option key={value} value={value}>
                        {GENERAL_CLASSIFICATION_LABELS[value]}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={classificationLoading}
                    disabled={
                      classificationLoading ||
                      classificationChoice === detail.generalClassification
                    }
                    onClick={handleClassificationUpdate}
                  >
                    Save Classification
                  </Button>
                  <span className={styles.fieldNote}>
                    Currently:{" "}
                    {generalClassificationLabel(detail.generalClassification)}
                  </span>
                </div>
                <p className={styles.fieldNote} style={{ marginTop: "0.5rem" }}>
                  Optional. Left unclassified unless an admin chooses a value —
                  the Category filter above only searches and never changes this.
                </p>
                {classificationError && (
                  <p
                    className={styles.formError}
                    style={{ marginTop: "0.75rem" }}
                  >
                    {classificationError}
                  </p>
                )}
                {classificationSuccess && (
                  <p
                    className={styles.formSuccess}
                    style={{ marginTop: "0.75rem" }}
                  >
                    {classificationSuccess}
                  </p>
                )}
              </div>
            )}

            {/* Reply */}
            <div className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>Reply to Submitter</p>
              <div className={styles.formField}>
                <label htmlFor="enquiry-reply">
                  <Mail size={13} /> This reply is emailed to {detail.email}
                </label>
                <textarea
                  id="enquiry-reply"
                  className={styles.textarea}
                  rows={5}
                  maxLength={ENQUIRY_REPLY_MAX_LENGTH}
                  placeholder="Write your response to this enquiry..."
                  value={replyMessage}
                  onChange={(e) => {
                    setReplyMessage(e.target.value);
                    setReplyError("");
                    setReplySuccess("");
                  }}
                  disabled={replyLoading || !replyAllowed}
                />
                <div className={styles.replyMeta}>
                  <span>
                    The submitter&apos;s stored email address is always the
                    destination.
                  </span>
                  <span>
                    {replyMessage.length}/{ENQUIRY_REPLY_MAX_LENGTH}
                  </span>
                </div>
              </div>

              {!replyAllowed && (
                <p className={styles.fieldNote} style={{ marginTop: "0.5rem" }}>
                  This enquiry is closed. Reopen it before sending a reply.
                </p>
              )}

              {replyError && (
                <p className={styles.formError} style={{ marginTop: "0.75rem" }}>
                  {replyError}
                </p>
              )}
              {replySuccess && (
                <p
                  className={styles.formSuccess}
                  style={{ marginTop: "0.75rem" }}
                >
                  {replySuccess}
                </p>
              )}

              <div className={styles.modalActionsBetween}>
                <Button
                  variant="primary"
                  loading={replyLoading}
                  disabled={!replyAllowed || replyTooShort}
                  onClick={handleSendReply}
                >
                  <Send size={15} /> {replyLoading ? "Sending reply..." : "Send Reply"}
                </Button>
                <span className={styles.fieldNote}>
                  Sending marks the enquiry as responded once the provider
                  accepts the message.
                </span>
              </div>
            </div>

            {/* Audit history */}
            <div className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>
                Activity / Audit History
              </p>
              {auditLog.length === 0 ? (
                <p className={styles.auditEmpty}>
                  No recorded activity for this enquiry yet.
                </p>
              ) : (
                <div className={styles.auditList}>
                  {auditLog.map((entry, index) => {
                    const lines = auditLines(entry);
                    return (
                      <div
                        key={`${entry.action}-${entry.createdAt}-${index}`}
                        className={`${styles.auditItem} ${
                          entry.action === "enquiry.reply_failed"
                            ? styles.auditFailed
                            : ""
                        }`}
                      >
                        <div className={styles.auditDot}>
                          <Clock />
                        </div>
                        <div className={styles.auditBody}>
                          <span className={styles.auditAction}>
                            {entry.actorName} — {lines.title}
                          </span>
                          {lines.detail && (
                            <span className={styles.auditMeta}>
                              {lines.detail}
                            </span>
                          )}
                          <span className={styles.auditMeta}>
                            {formatDateTime(entry.createdAt)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </ModalScrollable>
        ) : null}

        {/* Pinned footer: the body above scrolls, Close stays visible. */}
        <div className={styles.modalActions}>
          <Button variant="secondary" onClick={closeDetail}>
            Close
          </Button>
        </div>
      </Modal>

      {/* ── Delete confirmation ─────────────────────────── */}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => {
          if (!deleteLoading) {
            setDeleting(null);
            setDeleteError("");
          }
        }}
        onConfirm={handleDelete}
        title="Delete Enquiry"
        description={`Delete enquiry ${deleting?.reference ?? ""}? This action permanently removes the enquiry.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteLoading}
      />

      {deleteError && (
        <p className={styles.formError}>{deleteError}</p>
      )}
    </div>
  );
}
