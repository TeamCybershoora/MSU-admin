"use client";

/**
 * Announcement Bar Management — CRUD for the shared `announcements` collection
 * that drives the site-wide announcement bar on the public MSU website.
 *
 * Data flow:
 *   1. GET    /api/admin/announcements  — list every announcement
 *   2. POST   /api/admin/announcements  — create
 *   3. PUT    /api/admin/announcements  — update / enable / disable / reorder
 *   4. DELETE /api/admin/announcements  — delete
 *
 * The public bar rotates only through announcements that are enabled AND inside
 * their (optional) schedule window; the public API applies that filter with
 * server time, so this page never has to be right about "now" to publish.
 *
 * Security: the JWT is attached to every request and all authorization is
 * re-checked server-side by authenticateAdmin(). The UI is never the source of
 * truth; client-side validation is only a UX courtesy.
 *
 * Timezone: scheduling fields are edited in IST and sent as ISO UTC strings, so
 * the stored instant never shifts.
 *
 * The CTA label ("View details"), the badges/icons and the decorative shapes are
 * built into the PUBLIC component and are not editable here — the preview below
 * mirrors that design for reference only.
 */

import { useState, useCallback, useEffect } from "react";
import {
  Plus,
  Edit3,
  Trash2,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
  Megaphone,
  ArrowRight,
  GraduationCap,
  CalendarClock,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import {
  formatIstDateTime,
  istInputToUtc,
  toIstInputValue,
  validateHref,
} from "@/lib/announcement-validation";
import styles from "./page.module.css";

interface AnnouncementRecord {
  id: string;
  eyebrow: string;
  headline: string;
  sub: string;
  href: string;
  isEnabled: boolean;
  startAt: string | null;
  endAt: string | null;
  displayOrder: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface AnnouncementForm {
  eyebrow: string;
  headline: string;
  sub: string;
  href: string;
  isEnabled: boolean;
  /** IST `datetime-local` wall clock; "" means "no bound". */
  startAt: string;
  endAt: string;
  displayOrder: string;
}

type AnnouncementStatus = "live" | "scheduled" | "expired" | "disabled";

function blankForm(): AnnouncementForm {
  return {
    eyebrow: "",
    headline: "",
    sub: "",
    href: "/admissions",
    isEnabled: true,
    startAt: "",
    endAt: "",
    displayOrder: "0",
  };
}

/**
 * Classify a record for display only. Uses the browser clock purely to label a
 * row (Live / Scheduled / Expired / Disabled) — it never decides publication;
 * the public API re-evaluates with server time.
 */
function statusOf(item: AnnouncementRecord): AnnouncementStatus {
  if (!item.isEnabled) return "disabled";
  const now = Date.now();
  const start = item.startAt ? new Date(item.startAt).getTime() : null;
  const end = item.endAt ? new Date(item.endAt).getTime() : null;
  if (start !== null && now < start) return "scheduled";
  if (end !== null && now > end) return "expired";
  return "live";
}

const STATUS_LABEL: Record<AnnouncementStatus, string> = {
  live: "Live",
  scheduled: "Scheduled",
  expired: "Expired",
  disabled: "Disabled",
};

function statusVariant(status: AnnouncementStatus): "success" | "info" | "warning" | "neutral" {
  if (status === "live") return "success";
  if (status === "scheduled") return "info";
  if (status === "expired") return "warning";
  return "neutral";
}

export default function AdminAnnouncementsPage() {
  const [items, setItems] = useState<AnnouncementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState<AnnouncementForm>(blankForm());
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");

  const [deleting, setDeleting] = useState<AnnouncementRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [rowBusyId, setRowBusyId] = useState("");

  const fetchItems = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/announcements", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError("Unable to load announcements.");
        return;
      }
      const data = await res.json();
      if (data.success) setItems(data.data as AnnouncementRecord[]);
      else setError(data.message || "Unable to load announcements.");
    } catch {
      setError("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchItems();
  }, [fetchItems]);

  function updateForm<K extends keyof AnnouncementForm>(
    field: K,
    value: AnnouncementForm[K]
  ) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function openCreate() {
    setFormMode("create");
    setEditingId("");
    const next = items.length
      ? Math.max(...items.map((it) => it.displayOrder)) + 10
      : 10;
    setForm({ ...blankForm(), displayOrder: String(next) });
    setFormError("");
    setFormSuccess("");
  }

  function openEdit(record: AnnouncementRecord) {
    setFormMode("edit");
    setEditingId(record.id);
    setForm({
      eyebrow: record.eyebrow,
      headline: record.headline,
      sub: record.sub,
      href: record.href,
      isEnabled: record.isEnabled,
      startAt: toIstInputValue(record.startAt),
      endAt: toIstInputValue(record.endAt),
      displayOrder: String(record.displayOrder ?? 0),
    });
    setFormError("");
    setFormSuccess("");
  }

  function closeForm() {
    if (formLoading) return;
    setFormMode(null);
    setEditingId("");
    setForm(blankForm());
    setFormError("");
    setFormSuccess("");
  }

  /** IST wall-clock form value → ISO UTC string ("" clears the bound). */
  function istToIso(value: string): string | null {
    if (!value) return "";
    const date = istInputToUtc(value);
    return date ? date.toISOString() : null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formLoading || !formMode) return;

    const headline = form.headline.trim();
    if (!headline) {
      setFormError("Headline is required.");
      return;
    }
    const hrefCheck = validateHref(form.href);
    if (!hrefCheck.ok) {
      setFormError(hrefCheck.message);
      return;
    }
    const orderNum = Number.parseInt(form.displayOrder, 10);
    if (!Number.isInteger(orderNum) || orderNum < 0) {
      setFormError("Display order must be zero or greater.");
      return;
    }

    const startIso = istToIso(form.startAt);
    const endIso = istToIso(form.endAt);
    if (startIso === null || endIso === null) {
      setFormError("Please enter a valid date and time.");
      return;
    }
    if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
      setFormError("End date/time must be later than the start date/time.");
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
      const body: Record<string, unknown> = {
        eyebrow: form.eyebrow.trim(),
        headline,
        sub: form.sub.trim(),
        href: form.href.trim(),
        isEnabled: form.isEnabled,
        startAt: startIso,
        endAt: endIso,
        displayOrder: orderNum,
      };
      if (formMode === "edit") body.id = editingId;

      const res = await fetch("/api/admin/announcements", {
        method: formMode === "edit" ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) {
        setFormError(data.message || "Failed to save the announcement.");
        return;
      }

      setFormSuccess(formMode === "edit" ? "Updated successfully!" : "Created successfully!");
      await fetchItems();
      setTimeout(() => {
        setFormMode(null);
        setEditingId("");
        setForm(blankForm());
        setFormError("");
        setFormSuccess("");
      }, 900);
    } catch {
      setFormError("Unable to connect to server.");
    } finally {
      setFormLoading(false);
    }
  }

  async function toggleEnabled(record: AnnouncementRecord) {
    if (rowBusyId) return;
    const token = getStoredToken();
    if (!token) return;
    setRowBusyId(record.id);
    try {
      const res = await fetch("/api/admin/announcements", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: record.id, isEnabled: !record.isEnabled }),
      });
      const data = await res.json();
      if (data.success) await fetchItems();
    } catch {
      /* keep current state; next fetch resyncs */
    } finally {
      setRowBusyId("");
    }
  }

  async function move(record: AnnouncementRecord, dir: -1 | 1) {
    if (rowBusyId) return;
    const index = items.findIndex((it) => it.id === record.id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= items.length) return;

    const token = getStoredToken();
    if (!token) return;

    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setRowBusyId(record.id);
    try {
      await Promise.all(
        reordered.map((it, i) => {
          const newOrder = (i + 1) * 10;
          if (it.displayOrder === newOrder) return Promise.resolve();
          return fetch("/api/admin/announcements", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ id: it.id, displayOrder: newOrder }),
          });
        })
      );
      await fetchItems();
    } catch {
      await fetchItems();
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
      const res = await fetch("/api/admin/announcements", {
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
        await fetchItems();
      }
    } catch {
      /* keep the dialog open */
    } finally {
      setDeleteLoading(false);
    }
  }

  // Preview source: the form values while editing, else the first live item.
  const firstLive = items.find((it) => statusOf(it) === "live") ?? items[0] ?? null;
  const preview =
    formMode !== null
      ? {
          eyebrow: form.eyebrow,
          headline: form.headline,
          sub: form.sub,
        }
      : {
          eyebrow: firstLive?.eyebrow ?? "",
          headline: firstLive?.headline ?? "ADMISSIONS OPEN",
          sub: firstLive?.sub ?? "Applications are now open for eligible programmes",
        };

  const renderActions = (record: AnnouncementRecord, index: number) => (
    <>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title="Move up"
        aria-label={`Move up: ${record.headline}`}
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
        aria-label={`Move down: ${record.headline}`}
        disabled={index === items.length - 1 || rowBusyId === record.id}
        onClick={() => move(record, 1)}
      >
        <ArrowDown size={15} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title={record.isEnabled ? "Disable" : "Enable"}
        aria-label={record.isEnabled ? `Disable: ${record.headline}` : `Enable: ${record.headline}`}
        disabled={rowBusyId === record.id}
        onClick={() => toggleEnabled(record)}
      >
        {record.isEnabled ? <EyeOff size={15} /> : <Eye size={15} />}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title="Edit"
        aria-label={`Edit: ${record.headline}`}
        disabled={rowBusyId === record.id}
        onClick={() => openEdit(record)}
      >
        <Edit3 size={15} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        title="Delete"
        aria-label={`Delete: ${record.headline}`}
        disabled={rowBusyId === record.id}
        onClick={() => setDeleting(record)}
      >
        <Trash2 size={15} />
      </Button>
    </>
  );

  const liveCount = items.filter((it) => statusOf(it) === "live").length;

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <CardHeader
          title="Announcement Bar"
          subtitle="The rotating banner at the top of every page of the public site"
          actions={
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus size={14} /> Add Announcement
            </Button>
          }
        />
        <p className={styles.hint}>
          Only enabled announcements inside their scheduled window appear publicly, in
          display order. The bar hides itself when nothing is eligible.
        </p>
      </Card>

      {/* Live preview — mirrors the public bar's design (content only). */}
      <Card className={styles.section}>
        <CardHeader
          title="Preview"
          subtitle={
            formMode !== null
              ? "Preview of the announcement you are editing"
              : `How the bar looks now (${liveCount} live)`
          }
        />
        <div className={styles.previewBar}>
          <div className={styles.previewBadge} aria-hidden="true">
            <GraduationCap size={24} strokeWidth={1.8} />
          </div>
          <div className={styles.previewCopy}>
            {preview.eyebrow && (
              <span className={styles.previewEyebrow}>{preview.eyebrow}</span>
            )}
            <p className={styles.previewHeadline}>{preview.headline || "Your headline"}</p>
            {preview.sub && <p className={styles.previewSub}>{preview.sub}</p>}
          </div>
          <span className={styles.previewCta} aria-hidden="true">
            View details <ArrowRight size={14} />
          </span>
        </div>
      </Card>

      <Card className={styles.section}>
        <CardHeader
          title={`Announcements (${items.length})`}
          subtitle="Desktop shows a table; phones show stacked cards"
        />

        {loading ? (
          <div className={styles.loadingState} role="status">
            <div className={styles.spinner} />
            <p>Loading announcements...</p>
          </div>
        ) : error ? (
          <ErrorState
            title="Unable to load announcements"
            description={error}
            onRetry={fetchItems}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Megaphone />}
            title="No announcements yet"
            description="Add an announcement to show it in the public bar."
          />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Headline</th>
                    <th>Status</th>
                    <th>Starts (IST)</th>
                    <th>Ends (IST)</th>
                    <th>Order</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((record, index) => {
                    const status = statusOf(record);
                    return (
                      <tr key={record.id}>
                        <td className={styles.nameCell}>
                          <span className={styles.rowTitle}>{record.headline}</span>
                          {record.eyebrow && (
                            <span className={styles.rowSummary}>{record.eyebrow}</span>
                          )}
                        </td>
                        <td>
                          <Badge variant={statusVariant(status)}>
                            {STATUS_LABEL[status]}
                          </Badge>
                        </td>
                        <td className={styles.dateCell}>
                          {record.startAt ? formatIstDateTime(record.startAt) : "—"}
                        </td>
                        <td className={styles.dateCell}>
                          {record.endAt ? formatIstDateTime(record.endAt) : "—"}
                        </td>
                        <td>
                          <span className={styles.orderCell}>#{record.displayOrder}</span>
                        </td>
                        <td className={styles.actionsCell}>{renderActions(record, index)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile only (<=600px): same array as the table above. */}
            <RecordList>
              {items.map((record, index) => {
                const status = statusOf(record);
                return (
                  <RecordCard
                    key={record.id}
                    title={record.headline}
                    subtitle={record.eyebrow || undefined}
                    actions={renderActions(record, index)}
                  >
                    <RecordField label="Status">
                      <Badge variant={statusVariant(status)}>
                        {STATUS_LABEL[status]}
                      </Badge>
                    </RecordField>
                    <RecordField label="Starts">
                      {record.startAt ? formatIstDateTime(record.startAt) : "—"}
                    </RecordField>
                    <RecordField label="Ends">
                      {record.endAt ? formatIstDateTime(record.endAt) : "—"}
                    </RecordField>
                    <RecordField label="Link">{record.href}</RecordField>
                    <RecordField label="Order">#{record.displayOrder}</RecordField>
                  </RecordCard>
                );
              })}
            </RecordList>
          </>
        )}
      </Card>

      <Modal open={formMode !== null} onClose={closeForm} maxWidth={600}>
        <form onSubmit={handleSubmit}>
          <h3 className={styles.modalTitle}>
            {formMode === "edit" ? "Edit Announcement" : "Add Announcement"}
          </h3>
          <p className={styles.modalDesc}>
            Appears in the public announcement bar when enabled and within its schedule.
          </p>

          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="announcement-eyebrow">
                Eyebrow <span className={styles.optional}>(optional)</span>
              </label>
              <input
                id="announcement-eyebrow"
                type="text"
                maxLength={120}
                placeholder="e.g. MSU · 2026–27 SESSION"
                value={form.eyebrow}
                onChange={(e) => updateForm("eyebrow", e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="announcement-headline">Headline *</label>
              <input
                id="announcement-headline"
                type="text"
                maxLength={200}
                placeholder="e.g. ADMISSIONS OPEN"
                value={form.headline}
                onChange={(e) => updateForm("headline", e.target.value)}
                required
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="announcement-sub">
                Supporting text <span className={styles.optional}>(optional)</span>
              </label>
              <textarea
                id="announcement-sub"
                rows={2}
                maxLength={300}
                placeholder="e.g. Applications are now open for eligible programmes"
                value={form.sub}
                onChange={(e) => updateForm("sub", e.target.value)}
                className={styles.textarea}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="announcement-href">Destination link *</label>
              <input
                id="announcement-href"
                type="text"
                maxLength={500}
                placeholder="e.g. /admissions or https://example.edu/page"
                value={form.href}
                onChange={(e) => updateForm("href", e.target.value)}
                required
              />
              <span className={styles.formHint}>
                Internal path (starts with /) or a full https URL.
              </span>
            </div>

            <label className={styles.inlineRow}>
              <input
                type="checkbox"
                checked={form.isEnabled}
                onChange={(e) => updateForm("isEnabled", e.target.checked)}
              />
              Enabled (eligible to display)
            </label>

            <div className={styles.scheduleGrid}>
              <div className={styles.formField}>
                <label htmlFor="announcement-start">
                  Start <span className={styles.optional}>(optional)</span>
                </label>
                <input
                  id="announcement-start"
                  type="datetime-local"
                  value={form.startAt}
                  onChange={(e) => updateForm("startAt", e.target.value)}
                />
              </div>

              <div className={styles.formField}>
                <label htmlFor="announcement-end">
                  End <span className={styles.optional}>(optional)</span>
                </label>
                <input
                  id="announcement-end"
                  type="datetime-local"
                  value={form.endAt}
                  onChange={(e) => updateForm("endAt", e.target.value)}
                />
              </div>
            </div>
            <p className={styles.tzNote}>
              <CalendarClock size={14} aria-hidden="true" /> Times are in IST (Asia/Kolkata).
              Leave blank for no start/end limit.
            </p>

            <div className={styles.formField}>
              <label htmlFor="announcement-order">Display Order</label>
              <input
                id="announcement-order"
                type="number"
                min={0}
                step={1}
                value={form.displayOrder}
                onChange={(e) => updateForm("displayOrder", e.target.value)}
              />
              <span className={styles.formHint}>Lower numbers rotate first.</span>
            </div>
          </div>

          {formError && <p className={styles.formError} role="alert">{formError}</p>}
          {formSuccess && <p className={styles.formSuccess} role="status">{formSuccess}</p>}

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
        title="Delete Announcement"
        description={`Delete "${deleting?.headline}"? It will be removed from the public announcement bar immediately.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
