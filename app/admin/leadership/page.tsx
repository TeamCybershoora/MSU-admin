"use client";

/**
 * University Leadership Management — manage the FIXED positions shown on the
 * homepage (Chancellor, Vice Chancellor).
 *
 * The admin does not browse generic records: the page shows the CURRENT
 * homepage content first. Each position is a card with the photograph currently
 * on the site, the person's details and their status, plus:
 *   - Edit            — change the details / replace the photograph (server-side
 *                       PUT; fields are limited to what the admin may manage)
 *   - Restore Default — reset the position to the university's default
 *                       information (server-side POST /restore; the browser
 *                       never supplies the default values)
 *   - Delete          — remove the record so the position is not displayed
 *
 * There is deliberately NO role/position picker, NO profile URL and NO route
 * field: positions are fixed and any link is application-controlled.
 *
 * Data flow:
 *   1. GET    /api/admin/leadership          — list records
 *   2. POST   /api/admin/images/upload       — store a newly picked photograph
 *   3. PUT    /api/admin/leadership          — update details / replace image
 *   4. POST   /api/admin/leadership/restore  — restore a position's defaults
 *   5. DELETE /api/admin/leadership          — delete a record
 *
 * Security: every endpoint requires an admin JWT (authenticateAdmin server-side)
 * and re-validates input; the UI is never trusted.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Edit3, Trash2, RotateCcw, ImageOff } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import {
  LEADERSHIP_ROLES,
  LEADERSHIP_ROLE_LABELS,
  type LeadershipRole,
} from "@/lib/leadership";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

interface LeadershipItem {
  id: string;
  role: LeadershipRole;
  name: string;
  designation: string;
  description: string;
  imageId: string;
  imageName: string;
  altText: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Public (same-origin) path that serves a stored image by id. */
function imageSrc(imageId: string): string {
  return `/api/images/${imageId}`;
}

export default function AdminLeadershipPage() {
  const [items, setItems] = useState<LeadershipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<LeadershipItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesignation, setFormDesignation] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAlt, setFormAlt] = useState("");
  const [formActive, setFormActive] = useState(true);
  const [formImageId, setFormImageId] = useState<string | null>(null);
  const [formImageName, setFormImageName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [restoring, setRestoring] = useState<LeadershipRole | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [deleting, setDeleting] = useState<LeadershipItem | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchItems = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/leadership", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError("Unable to load leadership records.");
        return;
      }
      const data = await res.json();
      if (data.success) setItems(data.data as LeadershipItem[]);
    } catch {
      setError("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Release the object URL created for a locally picked file.
  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  function itemForRole(role: LeadershipRole): LeadershipItem | undefined {
    return items.find((item) => item.role === role);
  }

  function resetForm() {
    setEditing(null);
    setFormName("");
    setFormDesignation("");
    setFormDescription("");
    setFormAlt("");
    setFormActive(true);
    setFormImageId(null);
    setFormImageName("");
    setFile(null);
    if (localPreview) URL.revokeObjectURL(localPreview);
    setLocalPreview(null);
    setFormError("");
    setFormSuccess("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function openEdit(item: LeadershipItem) {
    resetForm();
    setEditing(item);
    setFormName(item.name);
    setFormDesignation(item.designation);
    setFormDescription(item.description);
    setFormAlt(item.altText);
    setFormActive(item.isActive);
    setFormImageId(item.imageId);
    setFormImageName(item.imageName);
    setShowForm(true);
  }

  function closeForm() {
    if (formLoading) return;
    setShowForm(false);
    resetForm();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setFile(picked);
    setFormError("");
    if (localPreview) URL.revokeObjectURL(localPreview);
    setLocalPreview(picked ? URL.createObjectURL(picked) : null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formLoading || !editing) return;

    if (!formName.trim()) {
      setFormError("Name is required.");
      return;
    }
    if (!formDesignation.trim()) {
      setFormError("Designation is required.");
      return;
    }
    if (!formAlt.trim()) {
      setFormError("Alt text is required.");
      return;
    }

    const token = getStoredToken();
    if (!token) return;
    setFormLoading(true);
    setFormError("");
    setFormSuccess("");

    try {
      // 1) If a new file was picked, store it first and get its id.
      let imageId = formImageId;
      let imageName = formImageName;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const uploadRes = await fetch("/api/admin/images/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const uploadData = await uploadRes.json();
        if (!uploadData.success) {
          setFormError(uploadData.message || "Image upload failed.");
          return;
        }
        imageId = uploadData.imageId as string;
        imageName = (uploadData.imageName as string) ?? "";
      }

      if (!imageId) {
        setFormError("Please choose a photograph.");
        return;
      }

      // 2) Update ONLY the fields an admin may manage for this fixed position.
      const body: Record<string, unknown> = {
        id: editing.id,
        name: formName.trim(),
        designation: formDesignation.trim(),
        description: formDescription.trim(),
        imageId,
        imageName,
        altText: formAlt.trim(),
        isActive: formActive,
      };

      const res = await fetch("/api/admin/leadership", {
        method: "PUT",
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

      setFormSuccess("Updated successfully!");
      fetchItems();
      setTimeout(() => {
        setShowForm(false);
        resetForm();
      }, 1000);
    } catch {
      setFormError("Unable to connect to server.");
    } finally {
      setFormLoading(false);
    }
  }

  async function handleRestore() {
    if (!restoring || restoreLoading) return;
    setRestoreLoading(true);
    const token = getStoredToken();
    if (!token) {
      setRestoreLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/leadership/restore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: restoring }),
      });
      const data = await res.json();
      if (data.success) {
        setRestoring(null);
        fetchItems();
      }
    } catch {
      /* keep the dialog open */
    } finally {
      setRestoreLoading(false);
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
      const res = await fetch("/api/admin/leadership", {
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
        fetchItems();
      }
    } catch {
      /* keep the dialog open */
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <CardHeader
          title="University Leadership"
          subtitle="The leadership positions shown on the homepage"
        />
        <p className={styles.hint}>
          These two positions are fixed. Edit the current information or restore
          the university defaults; there are no additional roles to create and no
          profile links to configure.
        </p>
      </Card>

      <Card className={styles.section}>
        <CardHeader
          title="Current Homepage Leadership"
          subtitle="What visitors see on the public homepage right now"
        />

        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading leadership positions...</p>
          </div>
        ) : error ? (
          <ErrorState
            title="Unable to load leadership positions"
            description={error}
            onRetry={fetchItems}
          />
        ) : (
          <div className={styles.positions}>
            {LEADERSHIP_ROLES.map((role) => {
              const item = itemForRole(role);
              const label = LEADERSHIP_ROLE_LABELS[role];
              return (
                <article key={role} className={styles.positionCard}>
                  <div className={styles.positionHeader}>
                    <h3 className={styles.positionTitle}>{label}</h3>
                    {item ? (
                      <Badge variant={item.isActive ? "success" : "neutral"}>
                        {item.isActive ? "Active" : "Inactive"}
                      </Badge>
                    ) : (
                      <Badge variant="neutral">Not configured</Badge>
                    )}
                  </div>

                  {item ? (
                    <button
                      type="button"
                      className={styles.photoButton}
                      onClick={() => openEdit(item)}
                      title={`Edit ${label}`}
                      aria-label={`Edit ${label}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        className={styles.photo}
                        src={imageSrc(item.imageId)}
                        alt={item.altText}
                      />
                      <div className={styles.photoMeta}>
                        <span className={styles.positionName}>{item.name}</span>
                        <span className={styles.positionDesignation}>
                          {item.designation}
                        </span>
                      </div>
                    </button>
                  ) : (
                    <div className={styles.emptyPosition}>
                      <ImageOff className={styles.emptyIcon} aria-hidden="true" />
                      <p className={styles.emptyTitle}>
                        No {label} information is currently configured.
                      </p>
                      <p className={styles.emptyHint}>
                        Restore the default details to show the university&apos;s
                        default {label.toLowerCase()} on the homepage.
                      </p>
                    </div>
                  )}

                  <div className={styles.positionActions}>
                    {item && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => openEdit(item)}
                      >
                        <Edit3 size={14} /> Edit
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setRestoring(role)}
                    >
                      <RotateCcw size={14} /> Restore Default
                    </Button>
                    {item && (
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title="Delete"
                        aria-label={`Delete ${label}`}
                        onClick={() => setDeleting(item)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={showForm} onClose={closeForm} maxWidth={560}>
        <form onSubmit={handleSubmit}>
          <h3 className={styles.modalTitle}>
            {editing
              ? `Edit ${LEADERSHIP_ROLE_LABELS[editing.role]}`
              : "Edit Leadership"}
          </h3>
          <p className={styles.modalDesc}>
            Update the information or replace the photograph shown on the
            homepage.
          </p>

          <div className={styles.formFields}>
            {(localPreview || formImageId) && (
              <div className={styles.previewWrap}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.previewImg}
                  src={localPreview ?? imageSrc(formImageId as string)}
                  alt="Current photograph preview"
                />
              </div>
            )}

            <div className={styles.formField}>
              <label htmlFor="leadership-image">Replace Photograph (optional)</label>
              <input
                id="leadership-image"
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
              />
              <span className={styles.hint}>
                JPEG, PNG or WebP, up to 5 MB. A square portrait crops best.
              </span>
            </div>

            <div className={styles.formField}>
              <label htmlFor="leadership-name">Name *</label>
              <input
                id="leadership-name"
                type="text"
                maxLength={120}
                placeholder="e.g. Smt. Anandiben Patel"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="leadership-designation">Designation *</label>
              <input
                id="leadership-designation"
                type="text"
                maxLength={120}
                placeholder="e.g. Hon'ble Chancellor"
                value={formDesignation}
                onChange={(e) => setFormDesignation(e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="leadership-description">Description</label>
              <textarea
                id="leadership-description"
                maxLength={2000}
                placeholder="Optional short biography or details."
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="leadership-alt">Alt Text *</label>
              <input
                id="leadership-alt"
                type="text"
                maxLength={200}
                placeholder="e.g. Portrait of Smt. Anandiben Patel"
                value={formAlt}
                onChange={(e) => setFormAlt(e.target.value)}
              />
            </div>

            <label className={styles.inlineRow}>
              <input
                type="checkbox"
                checked={formActive}
                onChange={(e) => setFormActive(e.target.checked)}
              />
              Show on the public homepage (active)
            </label>
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
              Update
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!restoring}
        onClose={() => {
          if (!restoreLoading) setRestoring(null);
        }}
        onConfirm={handleRestore}
        title="Restore Default Details?"
        description={
          restoring
            ? `This will replace the current ${
                LEADERSHIP_ROLE_LABELS[restoring]
              } information with the default university information.`
            : ""
        }
        confirmLabel="Restore Default"
        variant="warning"
        loading={restoreLoading}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => {
          if (!deleteLoading) setDeleting(null);
        }}
        onConfirm={handleDelete}
        title="Delete Leadership Information"
        description={`Are you sure you want to delete the ${
          deleting ? LEADERSHIP_ROLE_LABELS[deleting.role] : ""
        } information? The homepage will omit this card until you restore the default.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
