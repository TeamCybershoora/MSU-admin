"use client";

/**
 * SyllabusSemesterCard — one semester and its subjects.
 *
 * Rendered from data for every semester of every programme (BCA Semester 1,
 * B.Tech Semester 2, …). All actions are delegated upward with the record it
 * was given, so deleting/editing here never hard-codes a programme, semester or
 * subject name.
 *
 * The semester PDF is handled by the parent's semester form (View / Replace /
 * Remove all live there); this card surfaces it and offers the semester-level
 * Edit and Delete actions.
 */

import { Edit3, Eye, FileText, Plus, Trash2 } from "lucide-react";
import Button from "@/components/ui/button";
import SyllabusSubjectRow from "./syllabus-subject-row";
import type { SyllabusRecord, SyllabusSubject } from "./types";
import styles from "./syllabus.module.css";

interface SyllabusSemesterCardProps {
  record: SyllabusRecord;
  disabled?: boolean;
  onViewSemester: (record: SyllabusRecord) => void;
  onEditSemester: (record: SyllabusRecord) => void;
  onDeleteSemester: (record: SyllabusRecord) => void;
  onAddSubject: (record: SyllabusRecord) => void;
  onEditSubject: (record: SyllabusRecord, subject: SyllabusSubject) => void;
  onDeleteSubject: (record: SyllabusRecord, subject: SyllabusSubject) => void;
}

export default function SyllabusSemesterCard({
  record,
  disabled = false,
  onViewSemester,
  onEditSemester,
  onDeleteSemester,
  onAddSubject,
  onEditSubject,
  onDeleteSubject,
}: SyllabusSemesterCardProps) {
  const subjectCount = record.subjects.length;

  return (
    <div className={styles.semesterCard}>
      <div className={styles.semesterHeader}>
        <div>
          <h4 className={styles.semesterTitle}>Semester {record.semester}</h4>
          <p className={styles.semesterMeta}>
            {subjectCount} {subjectCount === 1 ? "subject" : "subjects"}
            {record.pdfUrl ? " · Semester PDF attached" : ""}
          </p>
        </div>
        <div className={styles.rowActions}>
          {record.pdfUrl && (
            <a
              className={styles.pdfLink}
              href={record.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileText size={14} /> View PDF
            </a>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            title={`View ${record.programme} Semester ${record.semester}`}
            onClick={() => onViewSemester(record)}
            disabled={disabled}
          >
            <Eye size={15} />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onEditSemester(record)}
            disabled={disabled}
          >
            <Edit3 size={14} /> Edit
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => onDeleteSemester(record)}
            disabled={disabled}
          >
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      </div>

      <div className={styles.subjectList}>
        {subjectCount === 0 ? (
          <p className={styles.emptyHint}>
            No subjects in this semester yet. Use “Add Subject” below.
          </p>
        ) : (
          record.subjects.map((subject, index) => (
            <SyllabusSubjectRow
              key={`${subject.subjectCode}-${index}`}
              subject={subject}
              disabled={disabled}
              onEdit={(s) => onEditSubject(record, s)}
              onDelete={(s) => onDeleteSubject(record, s)}
            />
          ))
        )}
      </div>

      <div className={styles.semesterFooter}>
        <Button
          type="button"
          variant="teal"
          size="sm"
          onClick={() => onAddSubject(record)}
          disabled={disabled}
        >
          <Plus size={14} /> Add Subject
        </Button>
      </div>
    </div>
  );
}
