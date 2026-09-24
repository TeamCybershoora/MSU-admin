"use client";

/**
 * SyllabusSubjectForm — ADD a new subject or EDIT one existing subject.
 *
 * The same modal is used for both because it only needs a programme + semester
 * identifier and an optional existing subject; nothing is programme- or
 * semester-specific. In ADD mode the code is entered directly and does not have
 * to correspond to any existing subject. Submitting calls back into the parent,
 * which performs the generic
 * `updateSubject(programme, semester, subject, originalCode)` API call, so no
 * CRUD logic is duplicated here.
 *
 * All existing subject fields are editable: code, name, syllabus URL and PDF URL.
 */

import { useState } from "react";
import Modal, { ModalScrollable } from "@/components/ui/modal";
import Button from "@/components/ui/button";
import { isHttpUrl, type ApiOutcome } from "./syllabus-api";
import type { SyllabusSubject } from "./types";
import styles from "./syllabus.module.css";

interface SyllabusSubjectFormProps {
  open: boolean;
  /** Subject being edited, or null when adding a new one. */
  subject: SyllabusSubject | null;
  /** Programme of the semester that owns the subject (display only). */
  programme: string;
  /** Semester that owns the subject (display only). */
  semester: number;
  onClose: () => void;
  onSave: (values: SyllabusSubject) => Promise<ApiOutcome>;
}

export default function SyllabusSubjectForm({
  open,
  subject,
  programme,
  semester,
  onClose,
  onSave,
}: SyllabusSubjectFormProps) {
  const [subjectCode, setSubjectCode] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [syllabusUrl, setSyllabusUrl] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset the form each time it is opened (or the edited subject changes).
  //
  // Adjusted during render rather than in an effect: the reset is derived purely
  // from props, so React can apply it in the same render pass instead of
  // committing a throwaway render first. `resetFor` only changes when the parent
  // changes the modal's open state or the edited subject, so this converges
  // immediately and cannot loop.
  const [resetFor, setResetFor] = useState<{
    open: boolean;
    subject: SyllabusSubject | null;
  }>({ open, subject });

  if (resetFor.open !== open || resetFor.subject !== subject) {
    setResetFor({ open, subject });
    if (open) {
      setSubjectCode(subject?.subjectCode ?? "");
      setSubjectName(subject?.subjectName ?? "");
      setSyllabusUrl(subject?.syllabusUrl ?? "");
      setPdfUrl(subject?.pdfUrl ?? "");
      setSaving(false);
      setError("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    const code = subjectCode.trim();
    const name = subjectName.trim();

    if (!code || !name) {
      setError("Subject code and subject name are required.");
      return;
    }
    if (syllabusUrl.trim() && !isHttpUrl(syllabusUrl)) {
      setError("Syllabus URL must be a valid http(s) link.");
      return;
    }
    if (pdfUrl.trim() && !isHttpUrl(pdfUrl)) {
      setError("PDF URL must be a valid http(s) link.");
      return;
    }

    setSaving(true);
    setError("");

    const outcome = await onSave({
      subjectCode: code,
      subjectName: name,
      syllabusUrl: syllabusUrl.trim() || null,
      pdfUrl: pdfUrl.trim() || null,
    });

    setSaving(false);
    if (!outcome.success) setError(outcome.message);
    // On success the parent closes the modal.
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      maxWidth={520}
    >
      <form onSubmit={handleSubmit}>
        <ModalScrollable>
          <h3 className={styles.modalTitle}>
            {subject ? "Edit Subject" : "Add New Subject"}
          </h3>
          <p className={styles.modalDesc}>
            {programme} — Semester {semester}
          </p>

          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="subject-code">Subject Code *</label>
              <input
                id="subject-code"
                type="text"
                placeholder="e.g. BCA-101"
                value={subjectCode}
                onChange={(e) => setSubjectCode(e.target.value)}
                disabled={saving}
                required
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="subject-name">Subject Name *</label>
              <input
                id="subject-name"
                type="text"
                placeholder="e.g. Mathematics"
                value={subjectName}
                onChange={(e) => setSubjectName(e.target.value)}
                disabled={saving}
                required
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="subject-syllabus-url">Syllabus URL (optional)</label>
              <input
                id="subject-syllabus-url"
                type="url"
                placeholder="https://…"
                value={syllabusUrl}
                onChange={(e) => setSyllabusUrl(e.target.value)}
                disabled={saving}
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="subject-pdf-url">Subject PDF URL (optional)</label>
              <input
                id="subject-pdf-url"
                type="url"
                placeholder="https://…"
                value={pdfUrl}
                onChange={(e) => setPdfUrl(e.target.value)}
                disabled={saving}
              />
              <span className={styles.formHint}>
                Leave blank when no per-subject PDF is published.
              </span>
            </div>
          </div>

          {error && <p className={styles.formError}>{error}</p>}
        </ModalScrollable>

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
            {subject ? "Update Subject" : "Add Subject"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
