"use client";

/**
 * PdfAttachmentField — reusable PDF attachment control.
 *
 * Purely presentational: it renders whichever of the three states applies
 * (newly picked file / currently attached file / nothing attached) and reports
 * the user's intent back to its parent, which owns the file input and the
 * upload. Used by both the semester form and the official programme PDF card,
 * so the attachment UI exists in exactly one place.
 *
 * The parent renders the hidden `<input type="file">` and passes its `onChoose`
 * handler, because the input must be reset from the same component that owns
 * the pending-file state.
 */

import { FileText, Plus } from "lucide-react";
import Button from "@/components/ui/button";
import styles from "./syllabus.module.css";

interface PdfAttachmentFieldProps {
  /** URL of the currently stored PDF (null = nothing attached). */
  currentUrl: string | null;
  /** Display name of the currently stored PDF. */
  currentName: string | null;
  /** File picked in this session, not uploaded yet. */
  pendingFile: File | null;
  /** Small label beside the attached name, e.g. "Official" / "Attached". */
  badge?: string;
  /** Text shown when nothing is attached. */
  emptyHint?: string;
  /** Label of the choose button when nothing is attached. */
  chooseLabel?: string;
  /** Label of the replace button. */
  replaceLabel?: string;
  uploading?: boolean;
  disabled?: boolean;
  /** When false, no Remove action is offered for the stored PDF. */
  allowRemove?: boolean;
  onChoose: () => void;
  onCancelSelection: () => void;
  onRemove: () => void;
}

export default function PdfAttachmentField({
  currentUrl,
  currentName,
  pendingFile,
  badge,
  emptyHint = "No file selected",
  chooseLabel = "Choose PDF",
  replaceLabel = "Replace PDF",
  uploading = false,
  disabled = false,
  allowRemove = false,
  onChoose,
  onCancelSelection,
  onRemove,
}: PdfAttachmentFieldProps) {
  const busy = disabled || uploading;

  return (
    <div className={styles.pdfBox}>
      {pendingFile ? (
        <>
          <span className={styles.pdfName}>
            <FileText size={15} /> {pendingFile.name}
          </span>
          <div className={styles.pdfActions}>
            {uploading && <span className={styles.pdfHint}>Uploading…</span>}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onChoose}
              disabled={busy}
            >
              {replaceLabel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancelSelection}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : currentUrl ? (
        <>
          <span className={styles.pdfName}>
            <FileText size={15} /> {currentName || "Syllabus PDF"}
            {badge && <span className={styles.pdfBadge}>{badge}</span>}
          </span>
          <div className={styles.pdfActions}>
            <a
              className={styles.pdfLink}
              href={currentUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View
            </a>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onChoose}
              disabled={busy}
            >
              {replaceLabel}
            </Button>
            {allowRemove && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRemove}
                disabled={busy}
              >
                Remove
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <span className={styles.pdfHint}>{emptyHint}</span>
          <Button
            type="button"
            variant="teal"
            size="sm"
            onClick={onChoose}
            disabled={busy}
          >
            <Plus size={14} /> {chooseLabel}
          </Button>
        </>
      )}
    </div>
  );
}
