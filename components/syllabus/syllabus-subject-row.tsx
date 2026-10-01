"use client";

/**
 * SyllabusSubjectRow — one subject inside a semester card.
 *
 * Rendered from data for every semester of every programme; it has no
 * knowledge of which programme/semester it belongs to, so the same component
 * serves BCA Semester 1 and B.Tech Semester 2.
 *
 * It owns the per-subject DOCUMENT actions (Upload / View / Replace / Remove
 * PDF) for a subject that already exists in ProgrammeStructure. The subject's
 * code/name/credits/assessment are never editable here — removing a PDF removes
 * the document attachment only, never the academic subject.
 */

import { useRef } from "react";
import { Edit3, FileText, Trash2 } from "lucide-react";
import Button from "@/components/ui/button";
import type { SyllabusSubject } from "./types";
import styles from "./syllabus.module.css";

interface SyllabusSubjectRowProps {
  subject: SyllabusSubject;
  disabled?: boolean;
  /**
   * Legacy (session-less) document: its academic identity cannot be validated,
   * so editing is withheld and only removal is offered.
   */
  legacy?: boolean;
  /** True while this row's PDF is being uploaded. */
  uploading?: boolean;
  onUploadPdf: (subject: SyllabusSubject, file: File) => void;
  onRemovePdf: (subject: SyllabusSubject) => void;
  onEdit: (subject: SyllabusSubject) => void;
  onDelete: (subject: SyllabusSubject) => void;
}

export default function SyllabusSubjectRow({
  subject,
  disabled = false,
  legacy = false,
  uploading = false,
  onUploadPdf,
  onRemovePdf,
  onEdit,
  onDelete,
}: SyllabusSubjectRowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = disabled || uploading;
  const canManagePdf = !legacy;

  function choosePdf() {
    fileInputRef.current?.click();
  }

  return (
    <div className={styles.subjectRow}>
      <div className={styles.subjectInfo}>
        <span className={styles.subjectCode}>{subject.subjectCode}</span>
        <span className={styles.subjectName}>{subject.subjectName}</span>
        {subject.syllabusUrl && (
          <span className={styles.subjectLinks}>
            <a
              className={styles.pdfLink}
              href={subject.syllabusUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Syllabus
            </a>
          </span>
        )}
      </div>

      <div className={styles.rowActions}>
        {subject.pdfUrl ? (
          <span className={styles.subjectPdfActions}>
            <a
              className={styles.pdfLink}
              href={subject.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileText size={12} /> View
            </a>
            {canManagePdf && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={choosePdf}
                  disabled={busy}
                >
                  Replace
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title="Remove the PDF attachment only (the subject is kept)"
                  onClick={() => onRemovePdf(subject)}
                  disabled={busy}
                >
                  Remove PDF
                </Button>
              </>
            )}
          </span>
        ) : canManagePdf ? (
          <span className={styles.subjectPdfActions}>
            {uploading ? (
              <span className={styles.subjectPdfHint}>Uploading…</span>
            ) : (
              <Button
                type="button"
                variant="teal"
                size="sm"
                onClick={choosePdf}
                disabled={busy}
              >
                Upload PDF
              </Button>
            )}
          </span>
        ) : null}

        {!legacy && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            title={`Edit ${subject.subjectCode}`}
            aria-label={`Edit ${subject.subjectCode}`}
            onClick={() => onEdit(subject)}
            disabled={busy}
          >
            <Edit3 size={15} />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          title={`Delete ${subject.subjectCode}`}
          aria-label={`Delete ${subject.subjectCode}`}
          onClick={() => onDelete(subject)}
          disabled={busy}
        >
          <Trash2 size={15} />
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className={styles.hiddenInput}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = "";
            if (file) onUploadPdf(subject, file);
          }}
        />
      </div>
    </div>
  );
}
