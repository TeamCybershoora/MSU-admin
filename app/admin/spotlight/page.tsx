"use client";

/**
 * Spotlight Management — manage the homepage "Campus in the spotlight" gallery.
 *
 * The primary view shows the CURRENT homepage images as a visual grid, so the
 * admin recognises what is live and clicks the image they want to change rather
 * than hunting through generic records. Each tile supports:
 *   - click the image to edit (replace image, edit alt text, enable/disable)
 *   - reorder with up/down controls (display order is retained)
 *   - delete the image and its stored bytes
 *
 * "Add Image" is deliberately secondary — it sits in the header as a secondary
 * action, after the current-content view.
 *
 * Data flow:
 *   1. GET    /api/admin/spotlight          — list items
 *   2. POST   /api/admin/images/upload      — store a newly picked image
 *   3. POST   /api/admin/spotlight          — create an item
 *   4. PUT    /api/admin/spotlight          — update metadata / replace image
 *   5. DELETE /api/admin/spotlight          — delete an item
 *
 * Security:
 * - Every endpoint requires an admin JWT (authenticateAdmin server-side).
 * - File type/size are validated on the server from the raw bytes; the browser
 *   checks here are only a UX courtesy.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Plus,
  Edit3,
  Trash2,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
  Image as ImageIcon,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

interface SpotlightItem {
  id: string;
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

export default function AdminSpotlightPage() {
  const [items, setItems] = useState<SpotlightItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SpotlightItem | null>(null);
  const [formAlt, setFormAlt] = useState("");
  const [formOrder, setFormOrder] = useState("0");
  const [formActive, setFormActive] = useState(true);
  // Image currently attached to the form (existing id or a freshly uploaded one).
  const [formImageId, setFormImageId] = useState<string | null>(null);
  const [formImageName, setFormImageName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleting, setDeleting] = useState<SpotlightItem | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchItems = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/spotlight", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError("Unable to load spotlight images.");
        return;
      }
      const data = await res.json();
      if (data.success) setItems(data.data as SpotlightItem[]);
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

  function resetForm() {
    setEditing(null);
    setFormAlt("");
    setFormOrder("0");
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

  function openCreate() {
    resetForm();
    // Default to the end of the gallery so a new image does not jump to the front.
    const nextOrder = items.length
      ? Math.max(...items.map((it) => it.displayOrder)) + 10
      : 10;
    setFormOrder(String(nextOrder));
    setShowForm(true);
  }

  function openEdit(item: SpotlightItem) {
    resetForm();
    setEditing(item);
    setFormAlt(item.altText);
    setFormOrder(String(item.displayOrder));
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
    if (formLoading) return;

    const alt = formAlt.trim();
    if (!alt) {
      setFormError("Alt text is required.");
      return;
    }
    if (!formImageId && !file) {
      setFormError("Please choose an image.");
      return;
    }
    const orderNum = Number.parseInt(formOrder, 10);
    if (!Number.isInteger(orderNum) || orderNum < 0) {
      setFormError("Display order must be zero or greater.");
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
        setFormError("Please choose an image.");
        return;
      }

      // 2) Create or update the item.
      const body: Record<string, unknown> = {
        imageId,
        imageName,
        altText: alt,
        displayOrder: orderNum,
        isActive: formActive,
      };
      if (editing) body.id = editing.id;

      const res = await fetch("/api/admin/spotlight", {
        method: editing ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) {
        setFormError(data.message || "Failed to save the spotlight item.");
        return;
      }

      setFormSuccess(editing ? "Updated successfully!" : "Added successfully!");
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

  async function handleToggleActive(item: SpotlightItem) {
    const token = getStoredToken();
    if (!token) return;
    try {
      const res = await fetch("/api/admin/spotlight", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: item.id, isActive: !item.isActive }),
      });
      const data = await res.json();
      if (data.success) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, isActive: !it.isActive } : it
          )
        );
      }
    } catch {
      /* keep the previous state */
    }
  }

  async function handleMove(item: SpotlightItem, dir: -1 | 1) {
    const index = items.findIndex((it) => it.id === item.id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= items.length) return;

    const token = getStoredToken();
    if (!token) return;

    // Swap positions, then persist a stable, evenly spaced order for every row
    // whose value actually changed.
    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

    try {
      await Promise.all(
        reordered.map((it, i) => {
          const newOrder = (i + 1) * 10;
          if (it.displayOrder === newOrder) return Promise.resolve();
          return fetch("/api/admin/spotlight", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ id: it.id, displayOrder: newOrder }),
          });
        })
      );
      fetchItems();
    } catch {
      /* refetch to resync on any failure */
      fetchItems();
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
      const res = await fetch("/api/admin/spotlight", {
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
          title="Campus in the Spotlight"
          subtitle="The images shown in the homepage gallery"
          actions={
            <Button variant="secondary" size="sm" onClick={openCreate}>
              <Plus size={14} /> Add Image
            </Button>
          }
        />
        <p className={styles.hint}>
          These are the images currently used in the Campus in the Spotlight
          section. Click an image to edit it. Only active images appear on the
          public homepage, in display order.
        </p>
      </Card>

      <Card className={styles.section}>
        <CardHeader
          title={`Current Images (${items.length})`}
          subtitle="What visitors see in the homepage gallery right now"
        />
        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading spotlight images...</p>
          </div>
        ) : error ? (
          <ErrorState
            title="Unable to load spotlight images"
            description={error}
            onRetry={fetchItems}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ImageIcon />}
            title="No spotlight images yet"
            description="Add an image to feature it on the homepage gallery."
          />
        ) : (
          <div className={styles.grid}>
            {items.map((item, index) => (
              <article key={item.id} className={styles.tile}>
                <button
                  type="button"
                  className={styles.tileImageButton}
                  onClick={() => openEdit(item)}
                  title="Edit image"
                  aria-label={`Edit image: ${item.altText}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className={styles.tileImage}
                    src={imageSrc(item.imageId)}
                    alt={item.altText}
                  />
                </button>

                <div className={styles.tileBody}>
                  <div className={styles.tileTopRow}>
                    <span className={styles.tileOrder}>#{item.displayOrder}</span>
                    <Badge variant={item.isActive ? "success" : "neutral"}>
                      {item.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <p className={styles.tileAlt}>{item.altText}</p>
                  <div className={styles.tileActions}>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title="Move up"
                      aria-label={`Move ${item.altText} up`}
                      disabled={index === 0}
                      onClick={() => handleMove(item, -1)}
                    >
                      <ArrowUp size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title="Move down"
                      aria-label={`Move ${item.altText} down`}
                      disabled={index === items.length - 1}
                      onClick={() => handleMove(item, 1)}
                    >
                      <ArrowDown size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title={item.isActive ? "Disable" : "Enable"}
                      aria-label={
                        item.isActive
                          ? `Disable ${item.altText}`
                          : `Enable ${item.altText}`
                      }
                      onClick={() => handleToggleActive(item)}
                    >
                      {item.isActive ? <EyeOff size={15} /> : <Eye size={15} />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title="Edit"
                      aria-label={`Edit ${item.altText}`}
                      onClick={() => openEdit(item)}
                    >
                      <Edit3 size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title="Delete"
                      aria-label={`Delete ${item.altText}`}
                      onClick={() => setDeleting(item)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      <Modal open={showForm} onClose={closeForm}>
        <form onSubmit={handleSubmit}>
          <h3 className={styles.modalTitle}>
            {editing ? "Edit Spotlight Image" : "Add Spotlight Image"}
          </h3>
          <p className={styles.modalDesc}>
            {editing
              ? "Update the image or its details."
              : "Upload an image and describe it for screen readers."}
          </p>

          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="spotlight-image">
                {editing ? "Replace Image (optional)" : "Image *"}
              </label>
              <input
                id="spotlight-image"
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
              />
              <span className={styles.hint}>
                JPEG, PNG or WebP, up to 5 MB. Wider images (16:9) look best.
              </span>
            </div>

            {(localPreview || formImageId) && (
              <div className={styles.previewWrap}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.previewImg}
                  src={localPreview ?? imageSrc(formImageId as string)}
                  alt="Selected image preview"
                />
              </div>
            )}

            <div className={styles.formField}>
              <label htmlFor="spotlight-alt">Alt Text *</label>
              <input
                id="spotlight-alt"
                type="text"
                maxLength={200}
                placeholder="e.g. Students walking through the main campus courtyard"
                value={formAlt}
                onChange={(e) => setFormAlt(e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="spotlight-order">Display Order</label>
              <input
                id="spotlight-order"
                type="number"
                min={0}
                step={1}
                value={formOrder}
                onChange={(e) => setFormOrder(e.target.value)}
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
              {editing ? "Update" : "Create"}
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
        title="Delete Spotlight Image"
        description={`Are you sure you want to delete "${deleting?.altText}"? Its stored image will also be removed.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
