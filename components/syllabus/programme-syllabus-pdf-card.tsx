"use client";

/**
 * ProgrammeSyllabusPdfCard — the official programme-level syllabus PDF.
 *
 * Additive to the structured syllabus: a programme may publish ONE official
 * PDF (e.g. "BCA Complete Syllabus.pdf") that exists independently of any
 * semester/subject records. This card provides View / Replace / Delete for that
 * document only — deleting it never touches semesters, subjects or other
 * programmes, and deleting structured records never touches it.
 *
 * Storage reuses the existing GridFS flow (uploadSyllabusPdf + the
 * /api/admin/programme-syllabus route); no separate PDF system is introduced.
 */

import { useRef, useState } from "react";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import PdfAttachmentField from "./pdf-attachment-field";
import {
  deleteProgrammeSyllabus,
  readUploadedPdf,
  saveProgrammeSyllabus,
  uploadSyllabusPdf,
  validatePdfFile,
} from "./syllabus-api";
import type { ProgrammeSyllabusRecord } from "./types";
import styles from "./syllabus.module.css";

interface ProgrammeSyllabusPdfCardProps {
  /** Programme codes to offer as suggestions. */
  programmes: string[];
  /** Programme-level documents, to display the current PDF. */
  docs: ProgrammeSyllabusRecord[];
  /** Called after a successful save/delete so the parent can refresh. */
  onChanged: () => void | Promise<void>;
}

export default function ProgrammeSyllabusPdfCard({
  programmes,
  docs,
  onChanged,
}: ProgrammeSyllabusPdfCardProps) {
  const [programme, setProgramme] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const code = programme.trim().toUpperCase();
  const doc = docs.find((d) => d.programme === code) ?? null;
  const currentUrl = doc?.pdfUrl ?? null;
  const currentName = doc?.pdfName ?? null;

  /**
   * A PDF belongs to one programme — drop any pending selection when the
   * programme changes so it can never be saved against the wrong programme.
   * Handled in the change handler rather than an effect: the reset is a
   * consequence of the user action, not a synchronisation with an external
   * system, so it needs no effect and no extra render pass.
   */
  function handleProgrammeChange(value: string) {
    setProgramme(value);
    setPdfFile(null);
    setError("");
    setSuccess("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

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
    setSuccess("");
    setPdfFile(file);
  }

  function cancelPdfSelection() {
    setPdfFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSave() {
    if (loading) return;

    if (!code) {
      setError("Select or enter a programme.");
      return;
    }

    if (!pdfFile) {
      if (!currentUrl) setError("Choose a PDF file to upload.");
      else setSuccess("Programme syllabus PDF is already up to date.");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      // 1. Store the new file in GridFS via the shared upload endpoint.
      setUploading(true);
      const upload = await uploadSyllabusPdf(pdfFile);
      setUploading(false);

      if (!upload.success) {
        setError(upload.message);
        return;
      }

      const stored = readUploadedPdf(upload.body);

      if (!stored.pdfUrl) {
        setError("PDF upload failed.");
        return;
      }

      // 2. Persist the reference; the server removes any superseded GridFS
      //    file only after the new reference is safely stored.
      const saved = await saveProgrammeSyllabus(
        code,
        stored.pdfUrl,
        stored.pdfName
      );

      if (!saved.success) {
        setError(saved.message);
        return;
      }

      setPdfFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSuccess("Programme syllabus PDF saved.");
      await onChanged();
    } finally {
      setUploading(false);
      setLoading(false);
    }
  }

  async function handleRemove() {
    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const outcome = await deleteProgrammeSyllabus(code);
      if (!outcome.success) {
        setError(outcome.message);
        return;
      }

      setSuccess("Programme syllabus PDF removed.");
      await onChanged();
    } finally {
      setLoading(false);
      setConfirmOpen(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Official Programme Syllabus"
        subtitle="Upload one official syllabus PDF for an entire programme. No semester or subject records are required."
      />

      <div className={styles.formFields}>
        <div className={styles.formField}>
          <label htmlFor="programme-pdf-programme">Programme</label>
          <input
            id="programme-pdf-programme"
            type="text"
            list="programme-pdf-options"
            placeholder="e.g. BCA"
            value={programme}
            onChange={(e) => handleProgrammeChange(e.target.value)}
            disabled={loading}
          />
          <datalist id="programme-pdf-options">
            {programmes.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>

        <div className={styles.formField}>
          <label>Official Syllabus PDF</label>
          <PdfAttachmentField
            currentUrl={currentUrl}
            currentName={currentName}
            pendingFile={pdfFile}
            badge="Official"
            emptyHint={
              code
                ? "No official programme PDF attached"
                : "Select or enter a programme first"
            }
            chooseLabel="Choose PDF"
            replaceLabel="Replace"
            uploading={uploading}
            disabled={loading}
            allowRemove
            onChoose={choosePdf}
            onCancelSelection={cancelPdfSelection}
            onRemove={() => setConfirmOpen(true)}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className={styles.hiddenInput}
            onChange={handlePdfSelected}
          />
        </div>
      </div>

      {error && <p className={styles.formError}>{error}</p>}
      {success && <p className={styles.formSuccess}>{success}</p>}

      <div className={styles.saveRow}>
        <p className={styles.cardNote}>
          This PDF is the official syllabus document for the{" "}
          <strong>entire programme</strong> and is shown to students even when no
          semester or subject records exist. Removing it does not affect the
          structured syllabus.
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleSave}
          loading={loading}
          disabled={!code}
        >
          Save
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          if (!loading) setConfirmOpen(false);
        }}
        onConfirm={handleRemove}
        title="Delete Official Programme PDF"
        description={`Delete the official ${code || "programme"} syllabus PDF? Semesters, subjects and the structured syllabus are NOT deleted.`}
        confirmLabel="Delete PDF"
        variant="danger"
        loading={loading}
      />
    </Card>
  );
}
