"use client";

/**
 * SyllabusSubjectForm — ADD a subject document or EDIT one existing.
 *
 * The subject is SELECTED from Academic Structure for the owning semester
 * document's identity; its code is the identity and its name, credits, type and
 * assessment are read-only values from ProgrammeStructure. Subject Management
 * attaches documents — it never edits the academic definition of a subject.
 *
 * DOCUMENTS: the subject PDF is attached through the SAME shared GridFS upload
 * flow as the semester and programme PDFs (PdfAttachmentField + uploadSyllabusPdf),
 * so the administrator can Upload, Replace, View and Remove the PDF instead of
 * pasting a URL. The optional Syllabus URL stays a plain link.
 *
 * Identity of the document being managed:
 *   programmeCode + academicSession + semesterNumber + subjectCode
 *
 * In EDIT mode the subject code is fixed, so a document can never be moved to a
 * different subject by accident.
 */

import { useEffect, useRef, useState } from "react";
import Modal, { ModalScrollable } from "@/components/ui/modal";
import Button from "@/components/ui/button";
import PdfAttachmentField from "./pdf-attachment-field";
import {
  isHttpUrl,
  readUploadedPdf,
  uploadSyllabusPdf,
  validatePdfFile,
  type ApiOutcome,
} from "./syllabus-api";
import { identityLabel, type SyllabusSubject } from "./types";
import {
  formatAssessment,
  selectionRuleLabel,
  subjectCategoryLabel,
  subjectTypeLabel,
  type CurriculumSubject,
} from "@/components/academic-structure/types";
import styles from "./syllabus.module.css";

interface SyllabusSubjectFormProps {
  open: boolean;
  /** Subject document being edited, or null when adding a new one. */
  subject: SyllabusSubject | null;
  /** Owning semester document identity. */
  programme: string;
  academicSession: string | null;
  semester: number;
  /** Effectively-active subjects of the owning semester, from Academic Structure. */
  availableSubjects: CurriculumSubject[];
  /** Codes already attached to this semester document. */
  attachedCodes: string[];
  onClose: () => void;
  onSave: (values: SyllabusSubject) => Promise<ApiOutcome>;
}

export default function SyllabusSubjectForm({
  open,
  subject,
  programme,
  academicSession,
  semester,
  availableSubjects,
  attachedCodes,
  onClose,
  onSave,
}: SyllabusSubjectFormProps) {
  const [subjectCode, setSubjectCode] = useState("");
  const [syllabusUrl, setSyllabusUrl] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfCleared, setPdfCleared] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset whenever the modal opens or the edited subject changes (adjusted
  // during render — the reset is derived purely from props).
  const [resetFor, setResetFor] = useState<{
    open: boolean;
    subject: SyllabusSubject | null;
  }>({ open, subject });

  if (resetFor.open !== open || resetFor.subject !== subject) {
    setResetFor({ open, subject });
    if (open) {
      setSubjectCode(subject?.subjectCode ?? "");
      setSyllabusUrl(subject?.syllabusUrl ?? "");
      setPdfFile(null);
      setPdfCleared(false);
      setUploading(false);
      setSaving(false);
      setError("");
    }
  }

  // Keep the raw file input element in sync when the modal is re-opened.
  useEffect(() => {
    if (!open) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [open, subject]);

  const attached = new Set(attachedCodes.map((c) => c.toUpperCase()));
  const selectable = availableSubjects.filter(
    (s) =>
      !attached.has(s.subjectCode.toUpperCase()) ||
      s.subjectCode.toUpperCase() === (subject?.subjectCode ?? "").toUpperCase()
  );
  const metadata: CurriculumSubject | null =
    availableSubjects.find(
      (s) => s.subjectCode.toUpperCase() === subjectCode.toUpperCase()
    ) ?? null;

  const currentPdfUrl = pdfCleared ? null : subject?.pdfUrl ?? null;
  // A subject no longer effectively active cannot receive a NEW document (the
  // server enforces this too), but its existing document can still be cleared.
  const uploadBlocked = !!(subject && !metadata);

  function choosePdf() {
    fileInputRef.current?.click();
  }

  function handlePdfSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;

    const problem = validatePdfFile(file);
    if (problem) {
      setError(problem);
      e.target.value = "";
      return;
    }

    setError("");
    setPdfCleared(false);
    setPdfFile(file);
  }

  function cancelPdfSelection() {
    setPdfFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachedPdf() {
    setPdfFile(null);
    setPdfCleared(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    const code = subjectCode.trim();
    if (!code) {
      setError("Select a subject from Academic Structure.");
      return;
    }
    if (syllabusUrl.trim() && !isHttpUrl(syllabusUrl)) {
      setError("Syllabus URL must be a valid http(s) link.");
      return;
    }

    setSaving(true);
    setError("");

    // A newly picked file is stored first; the record only ever keeps the URL
    // reference returned by the shared upload endpoint.
    let pdfUrl: string | null;
    if (pdfFile) {
      setUploading(true);
      const upload = await uploadSyllabusPdf(pdfFile);
      setUploading(false);

      if (!upload.success) {
        setSaving(false);
        setError(upload.message);
        return;
      }
      pdfUrl = readUploadedPdf(upload.body).pdfUrl;
      if (!pdfUrl) {
        setSaving(false);
        setError("PDF upload failed.");
        return;
      }
    } else if (pdfCleared) {
      pdfUrl = null;
    } else {
      pdfUrl = subject?.pdfUrl ?? null;
    }

    const outcome = await onSave({
      subjectCode: code,
      // Display snapshot only; the server re-derives the name from the structure.
      subjectName: metadata?.subjectName ?? subject?.subjectName ?? code,
      syllabusUrl: syllabusUrl.trim() || null,
      pdfUrl,
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
      maxWidth={520}
    >
      <form onSubmit={handleSubmit}>
        <ModalScrollable>
          <h3 className={styles.modalTitle}>
            {subject ? "Edit Subject Document" : "Add Subject Document"}
          </h3>
          <p className={styles.modalDesc}>
            {identityLabel(programme, academicSession)} — Semester {semester}
          </p>

          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="subject-code">Subject *</label>
              {subject ? (
                <input
                  id="subject-code"
                  type="text"
                  value={subjectCode}
                  disabled
                />
              ) : (
                <select
                  id="subject-code"
                  value={subjectCode}
                  onChange={(e) => setSubjectCode(e.target.value)}
                  disabled={saving}
                  required
                >
                  <option value="">Select a subject…</option>
                  {selectable.map((s) => (
                    <option key={s.subjectCode} value={s.subjectCode}>
                      {s.subjectCode} — {s.subjectName}
                    </option>
                  ))}
                </select>
              )}
              <span className={styles.formHint}>
                Subjects come from Academic Structure. Academic details are
                managed there, not here.
              </span>
            </div>

            {metadata && (
              <div className={styles.readonlyMeta} aria-label="Academic metadata">
                <div className={styles.readonlyMetaRow}>
                  <span className={styles.readonlyMetaLabel}>Subject Name</span>
                  <span>{metadata.subjectName}</span>
                </div>
                <div className={styles.readonlyMetaRow}>
                  <span className={styles.readonlyMetaLabel}>Credits</span>
                  <span>{metadata.credits}</span>
                </div>
                <div className={styles.readonlyMetaRow}>
                  <span className={styles.readonlyMetaLabel}>Type</span>
                  <span>
                    {subjectTypeLabel(metadata.subjectType)}
                    {metadata.category !== "CORE"
                      ? ` · ${subjectCategoryLabel(metadata.category)}`
                      : ""}
                  </span>
                </div>
                {metadata.electiveGroup && (
                  <div className={styles.readonlyMetaRow}>
                    <span className={styles.readonlyMetaLabel}>Elective</span>
                    <span>
                      {metadata.electiveGroup}
                      {metadata.selectionRule
                        ? ` · ${selectionRuleLabel(metadata.selectionRule)}`
                        : ""}
                    </span>
                  </div>
                )}
                <div className={styles.readonlyMetaRow}>
                  <span className={styles.readonlyMetaLabel}>Assessment</span>
                  <span>{formatAssessment(metadata.assessment)}</span>
                </div>
              </div>
            )}

            {subject && !metadata && (
              <p className={styles.formHint} role="note">
                This subject is no longer effectively active in Academic
                Structure. The document link can still be cleared; the academic
                definition is managed in Academic Structure.
              </p>
            )}

            <div className={styles.formField}>
              <label>Subject PDF</label>
              <PdfAttachmentField
                currentUrl={currentPdfUrl}
                currentName={subject?.subjectName ?? null}
                pendingFile={pdfFile}
                badge="Subject"
                emptyHint={
                  pdfCleared
                    ? "PDF will be removed when you save"
                    : "No subject PDF attached"
                }
                chooseLabel="Upload PDF"
                replaceLabel="Replace"
                uploading={uploading}
                disabled={saving}
                disableUpload={uploadBlocked}
                // Removal clears the DOCUMENT attachment only — the academic
                // subject in ProgrammeStructure is never touched.
                allowRemove={!!subject}
                onChoose={choosePdf}
                onCancelSelection={cancelPdfSelection}
                onRemove={removeAttachedPdf}
              />
              {uploadBlocked && (
                <span className={styles.formHint} role="note">
                  This subject is not active in Academic Structure, so a new
                  upload is not offered. The attached PDF can still be removed.
                </span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className={styles.hiddenInput}
                onChange={handlePdfSelected}
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
            {uploading ? "Uploading…" : subject ? "Update Subject" : "Add Subject"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
