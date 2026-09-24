"use client";

/**
 * SyllabusSemesterForm — add a new semester, or edit an existing one.
 *
 * Reused for every programme: it only needs a programme identifier (or a
 * record to edit), so BCA and B.Tech share one implementation.
 *
 *   create → programme + semester + the initial subjects (+ optional PDF)
 *   edit   → renumber the semester and manage its semester-level PDF
 *            (View / Replace / Remove). Subjects of an existing semester are
 *            managed individually from the semester card, so an edit can never
 *            overwrite unrelated subjects by accident.
 *
 * PDF bytes are stored through the shared uploadSyllabusPdf helper; the parent
 * persists the reference with the generic create/update API call.
 */

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
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
import { emptySubject, type SyllabusRecord, type SyllabusSubject } from "./types";
import styles from "./syllabus.module.css";

/** Values handed to the parent, which performs the actual API call. */
export interface SemesterFormValues {
  programme: string;
  semester: number;
  /** Present in create mode only. */
  subjects?: SyllabusSubject[];
  /** `undefined` = leave the existing attachment untouched. */
  pdfUrl?: string | null;
  pdfName?: string | null;
}

interface SyllabusSemesterFormProps {
  open: boolean;
  mode: "create" | "edit";
  /** Semester being edited (edit mode). */
  record: SyllabusRecord | null;
  /** Pre-filled programme for a new semester (create mode). */
  defaultProgramme?: string;
  /** Known programme codes, offered as suggestions. */
  programmes?: string[];
  onClose: () => void;
  onSave: (values: SemesterFormValues) => Promise<ApiOutcome>;
}

const SEMESTER_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

export default function SyllabusSemesterForm({
  open,
  mode,
  record,
  defaultProgramme = "",
  programmes = [],
  onClose,
  onSave,
}: SyllabusSemesterFormProps) {
  const [programme, setProgramme] = useState("");
  const [semester, setSemester] = useState("1");
  const [subjects, setSubjects] = useState<SyllabusSubject[]>([emptySubject()]);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfCleared, setPdfCleared] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset the form whenever it is opened, or the record/mode changes.
  //
  // Adjusted during render rather than in an effect: the reset is derived purely
  // from props, so React can apply it in the same render pass instead of
  // committing a throwaway render first. `resetFor` only changes when the parent
  // changes the modal's open state, record or mode, so this converges immediately
  // and cannot loop.
  const [resetFor, setResetFor] = useState<{
    open: boolean;
    mode: "create" | "edit";
    record: SyllabusRecord | null;
    defaultProgramme: string;
  }>({ open, mode, record, defaultProgramme });

  if (
    resetFor.open !== open ||
    resetFor.mode !== mode ||
    resetFor.record !== record ||
    resetFor.defaultProgramme !== defaultProgramme
  ) {
    setResetFor({ open, mode, record, defaultProgramme });
    if (open) {
      setProgramme(mode === "edit" ? record?.programme ?? "" : defaultProgramme);
      setSemester(String(mode === "edit" ? record?.semester ?? 1 : 1));
      setSubjects([emptySubject()]);
      setPdfFile(null);
      setPdfCleared(false);
      setSubmitting(false);
      setUploading(false);
      setError("");
    }
  }

  // Clear the file input element itself on the same trigger. This touches only
  // the DOM and never updates state, so it is not a state update in an effect.
  useEffect(() => {
    if (!open) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [open, mode, record, defaultProgramme]);

  const isCreate = mode === "create";
  const currentPdfUrl = pdfCleared ? null : record?.pdfUrl ?? null;
  const currentPdfName = pdfCleared ? null : record?.pdfName ?? null;

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

  // ── Create-mode subject rows ─────────────────────────────────────

  function addSubjectRow() {
    setSubjects((prev) => [...prev, emptySubject()]);
  }

  function removeSubjectRow(index: number) {
    setSubjects((prev) => prev.filter((_, i) => i !== index));
  }

  function updateSubjectRow(
    index: number,
    field: keyof SyllabusSubject,
    value: string
  ) {
    setSubjects((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value || null } : s))
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const code = programme.trim().toUpperCase();
    if (!code) {
      setError("Programme is required.");
      return;
    }

    let validSubjects: SyllabusSubject[] | undefined;
    if (isCreate) {
      validSubjects = subjects.filter(
        (s) => s.subjectCode.trim() && s.subjectName.trim()
      );

      if (validSubjects.length === 0) {
        setError("At least one subject with a code and name is required.");
        return;
      }

      for (const s of validSubjects) {
        if (s.syllabusUrl && !isHttpUrl(s.syllabusUrl)) {
          setError(`Subject ${s.subjectCode}: syllabus URL must be a valid http(s) link.`);
          return;
        }
        if (s.pdfUrl && !isHttpUrl(s.pdfUrl)) {
          setError(`Subject ${s.subjectCode}: PDF URL must be a valid http(s) link.`);
          return;
        }
      }
    }

    setSubmitting(true);
    setError("");

    // A newly picked file is stored first; the record only ever keeps the URL
    // reference returned by the shared upload endpoint.
    let pdfUrl: string | null | undefined;
    let pdfName: string | null | undefined;

    if (pdfFile) {
      setUploading(true);
      const upload = await uploadSyllabusPdf(pdfFile);
      setUploading(false);

      if (!upload.success) {
        setSubmitting(false);
        setError(upload.message);
        return;
      }

      const stored = readUploadedPdf(upload.body);
      pdfUrl = stored.pdfUrl;
      pdfName = stored.pdfName;
    } else if (pdfCleared) {
      pdfUrl = null;
      pdfName = null;
    }

    const outcome = await onSave({
      programme: code,
      semester: Number(semester),
      ...(isCreate ? { subjects: validSubjects } : {}),
      pdfUrl,
      pdfName,
    });

    setSubmitting(false);
    if (!outcome.success) setError(outcome.message);
    // On success the parent closes the modal.
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      maxWidth={600}
    >
      <form onSubmit={handleSubmit}>
        <ModalScrollable>
          <h3 className={styles.modalTitle}>
            {isCreate ? "Add Semester" : "Edit Semester"}
          </h3>
          <p className={styles.modalDesc}>
            {isCreate
              ? "Create a semester syllabus with its subjects."
              : `${record?.programme ?? ""} — Semester ${record?.semester ?? ""}`}
          </p>

          <div className={styles.formFields}>
            {isCreate && (
              <div className={styles.formField}>
                <label htmlFor="semester-programme">Programme *</label>
                <input
                  id="semester-programme"
                  type="text"
                  list="semester-programme-options"
                  placeholder="e.g. BCA"
                  value={programme}
                  onChange={(e) => setProgramme(e.target.value)}
                  disabled={submitting}
                  required
                />
                <datalist id="semester-programme-options">
                  {programmes.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
            )}

            <div className={styles.formField}>
              <label htmlFor="semester-number">
                {isCreate ? "Semester *" : "Semester number"}
              </label>
              <select
                id="semester-number"
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
                disabled={submitting}
              >
                {SEMESTER_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {!isCreate && (
                <span className={styles.formHint}>
                  Changing this renumbers the semester; other semesters are not
                  affected.
                </span>
              )}
            </div>

            <div className={styles.formField}>
              <label>
                {isCreate ? "Semester Syllabus PDF (optional)" : "Semester Syllabus PDF"}
              </label>
              <PdfAttachmentField
                currentUrl={currentPdfUrl}
                currentName={currentPdfName}
                pendingFile={pdfFile}
                badge="Attached"
                emptyHint={
                  pdfCleared
                    ? "PDF will be removed when you save"
                    : "No semester PDF attached"
                }
                chooseLabel="Choose PDF"
                uploading={uploading}
                disabled={submitting}
                allowRemove={!isCreate}
                onChoose={choosePdf}
                onCancelSelection={cancelPdfSelection}
                onRemove={removeAttachedPdf}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className={styles.hiddenInput}
                onChange={handlePdfSelected}
              />
            </div>

            {isCreate ? (
              <>
                <div className={styles.inlineHeader}>
                  <label>Subjects *</label>
                  <Button
                    type="button"
                    variant="teal"
                    size="sm"
                    onClick={addSubjectRow}
                    disabled={submitting}
                  >
                    <Plus size={14} /> Add
                  </Button>
                </div>
                {subjects.map((subject, index) => (
                  <div key={index} className={styles.subjectRowInput}>
                    <input
                      type="text"
                      placeholder="Code"
                      value={subject.subjectCode}
                      onChange={(e) =>
                        updateSubjectRow(index, "subjectCode", e.target.value)
                      }
                      disabled={submitting}
                    />
                    <input
                      type="text"
                      placeholder="Name"
                      value={subject.subjectName}
                      onChange={(e) =>
                        updateSubjectRow(index, "subjectName", e.target.value)
                      }
                      disabled={submitting}
                    />
                    {subjects.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title="Remove subject"
                        onClick={() => removeSubjectRow(index)}
                        disabled={submitting}
                      >
                        ×
                      </Button>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <p className={styles.formHint}>
                Subjects are edited individually from the semester card’s Edit and
                Delete actions.
              </p>
            )}
          </div>

          {error && <p className={styles.formError}>{error}</p>}
        </ModalScrollable>

        <div className={styles.modalActions}>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {uploading ? "Uploading…" : isCreate ? "Create Semester" : "Save Changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
