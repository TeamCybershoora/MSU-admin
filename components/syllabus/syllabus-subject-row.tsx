"use client";

/**
 * SyllabusSubjectRow — one subject inside a semester card.
 *
 * Rendered from data for every semester of every programme; it has no
 * knowledge of which programme/semester it belongs to, so the same component
 * serves BCA Semester 1 and B.Tech Semester 2.
 */

import { Edit3, FileText, Trash2 } from "lucide-react";
import Button from "@/components/ui/button";
import type { SyllabusSubject } from "./types";
import styles from "./syllabus.module.css";

interface SyllabusSubjectRowProps {
  subject: SyllabusSubject;
  disabled?: boolean;
  onEdit: (subject: SyllabusSubject) => void;
  onDelete: (subject: SyllabusSubject) => void;
}

export default function SyllabusSubjectRow({
  subject,
  disabled = false,
  onEdit,
  onDelete,
}: SyllabusSubjectRowProps) {
  return (
    <div className={styles.subjectRow}>
      <div className={styles.subjectInfo}>
        <span className={styles.subjectCode}>{subject.subjectCode}</span>
        <span className={styles.subjectName}>{subject.subjectName}</span>
        {(subject.syllabusUrl || subject.pdfUrl) && (
          <span className={styles.subjectLinks}>
            {subject.syllabusUrl && (
              <a
                className={styles.pdfLink}
                href={subject.syllabusUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Syllabus
              </a>
            )}
            {subject.pdfUrl && (
              <a
                className={styles.pdfLink}
                href={subject.pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileText size={12} /> PDF
              </a>
            )}
          </span>
        )}
      </div>
      <div className={styles.rowActions}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          title={`Edit ${subject.subjectCode}`}
          onClick={() => onEdit(subject)}
          disabled={disabled}
        >
          <Edit3 size={15} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          title={`Delete ${subject.subjectCode}`}
          onClick={() => onDelete(subject)}
          disabled={disabled}
        >
          <Trash2 size={15} />
        </Button>
      </div>
    </div>
  );
}
