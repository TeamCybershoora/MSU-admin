"use client";

/**
 * SemesterForm — ADD or EDIT one semester of a structured curriculum.
 *
 * `semesterNumber` is the numeric identity (the same 1–12 range the Syllabus
 * module already uses) and `semesterName` is only a display label, so a
 * semester can be labelled "Semester I" without changing how it is addressed.
 *
 * In EDIT mode the subject list is deliberately untouched by this form: saving a
 * label or status change never rewrites subjects (the API keeps them as they are
 * when `subjects` is not sent).
 */

import { useState } from "react";
import Modal from "@/components/ui/modal";
import Button from "@/components/ui/button";
import {
  MAX_SEMESTERS_PER_STRUCTURE,
  STRUCTURE_STATUSES,
  type ProgrammeStructureStatus,
} from "@/lib/programme-structure";
import type { ApiOutcome } from "./academic-structure-api";
import type { CurriculumSemester } from "./types";
import styles from "./academic-structure.module.css";

export interface SemesterFormValues {
  semesterNumber: number;
  semesterName: string;
  status: ProgrammeStructureStatus;
}

interface SemesterFormProps {
  open: boolean;
  /** Semester being edited, or null when adding a new one. */
  semester: CurriculumSemester | null;
  /** Programme + session the semester belongs to (display only). */
  programmeCode: string;
  academicSession: string;
  onClose: () => void;
  onSave: (values: SemesterFormValues) => Promise<ApiOutcome>;
}

const SEMESTER_NUMBERS = Array.from(
  { length: MAX_SEMESTERS_PER_STRUCTURE },
  (_, index) => index + 1
);

export default function SemesterForm({
  open,
  semester,
  programmeCode,
  academicSession,
  onClose,
  onSave,
}: SemesterFormProps) {
  const [semesterNumber, setSemesterNumber] = useState(1);
  const [semesterName, setSemesterName] = useState("");
  const [status, setStatus] = useState<ProgrammeStructureStatus>("ACTIVE");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset on open / when the edited semester changes (see ProgrammeStructureForm
  // for why this is adjusted during render rather than in an effect).
  const [resetFor, setResetFor] = useState<{
    open: boolean;
    semester: CurriculumSemester | null;
  }>({ open, semester });

  if (resetFor.open !== open || resetFor.semester !== semester) {
    setResetFor({ open, semester });
    if (open) {
      setSemesterNumber(semester?.semesterNumber ?? 1);
      setSemesterName(semester?.semesterName ?? "");
      setStatus(semester?.status ?? "ACTIVE");
      setSaving(false);
      setError("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    setSaving(true);
    setError("");

    const outcome = await onSave({
      semesterNumber,
      semesterName: semesterName.trim(),
      status,
    });

    setSaving(false);
    if (!outcome.success) setError(outcome.message);
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      maxWidth={480}
    >
      <form onSubmit={handleSubmit}>
        <h3 className={styles.modalTitle}>
          {semester ? `Edit Semester ${semester.semesterNumber}` : "Add Semester"}
        </h3>
        <p className={styles.modalDesc}>
          {programmeCode} — {academicSession}
        </p>

        <div className={styles.formFields}>
          <div className={styles.formField}>
            <label htmlFor="semester-number">Semester Number *</label>
            <select
              id="semester-number"
              value={semesterNumber}
              onChange={(e) => setSemesterNumber(Number(e.target.value))}
              disabled={saving}
            >
              {SEMESTER_NUMBERS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <span className={styles.formHint}>
              The number is the semester&apos;s identity (1–
              {MAX_SEMESTERS_PER_STRUCTURE}); it is what Syllabus and Result
              select a semester by.
            </span>
          </div>

          <div className={styles.formField}>
            <label htmlFor="semester-name">Semester Name (optional)</label>
            <input
              id="semester-name"
              type="text"
              placeholder="e.g. Semester I"
              value={semesterName}
              onChange={(e) => setSemesterName(e.target.value)}
              disabled={saving}
            />
            <span className={styles.formHint}>
              Display label only. Leave blank to show &quot;Semester{" "}
              {semesterNumber}&quot;.
            </span>
          </div>

          <div className={styles.formField}>
            <label htmlFor="semester-status">Status</label>
            <select
              id="semester-status"
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as ProgrammeStructureStatus)
              }
              disabled={saving}
            >
              {STRUCTURE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <span className={styles.formHint}>
              An INACTIVE semester makes every subject inside it effectively
              unavailable — without rewriting any subject record.
            </span>
          </div>
        </div>

        {error && <p className={styles.formError}>{error}</p>}

        <div className={styles.modalActions}>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {semester ? "Save Semester" : "Add Semester"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
