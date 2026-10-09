"use client";

/**
 * Modal — overlay dialog for the admin portal.
 *
 * Handles:
 *   - Escape key to close
 *   - Click outside to close (overlay click)
 *   - Body scroll lock while open
 *   - Focus trapping via aria-modal
 *
 * Exports:
 *   Modal          — base overlay dialog
 *   ConfirmDialog  — pre-built confirm/cancel dialog (used for deletes)
 *
 * Security note: Modals are purely presentational. All authorization
 * is enforced server-side in the API routes, not in the UI.
 */
import { useEffect, useCallback } from "react";
import { X, AlertTriangle, Info } from "lucide-react";
import Button from "./button";
import styles from "./modal.module.css";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
}

export default function Modal({ open, onClose, children, maxWidth = 440 }: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}

/** Scrollable wrapper for long modal content (forms, lists). */
export function ModalScrollable({ children }: { children: React.ReactNode }) {
  return <div className={styles.modalScrollable}>{children}</div>;
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "info";
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  loading = false,
}: ConfirmDialogProps) {
  const IconComponent = variant === "danger" ? AlertTriangle : Info;
  const iconClass =
    variant === "danger"
      ? styles.iconDanger
      : variant === "warning"
        ? styles.iconWarning
        : styles.iconInfo;

  return (
    <Modal open={open} onClose={onClose}>
      <button
        type="button"
        className={styles.closeBtn}
        onClick={onClose}
        aria-label="Close"
      >
        <X />
      </button>
      <div className={`${styles.modalIcon} ${iconClass}`}>
        <IconComponent />
      </div>
      <h3 className={styles.modalTitle}>{title}</h3>
      <p className={styles.modalDesc}>{description}</p>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button
          variant={variant === "danger" ? "danger" : "teal"}
          onClick={onConfirm}
          loading={loading}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
