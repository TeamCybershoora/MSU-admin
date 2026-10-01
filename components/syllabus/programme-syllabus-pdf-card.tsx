"use client";

/**
 * ProgrammeSyllabusPdfCard — the official programme-level syllabus PDF.
 *
 * The document's identity is an ACADEMIC STRUCTURE: programme + academic
 * session. The admin chooses the programme and the session through two separate
 * searchable selectors (values come from Academic Structure, never typed by
 * hand), and the card shows/attaches the official PDF for that identity.
 *
 * Changing the programme clears the selected session (and any pending file);
 * changing the session drops a pending file, so a PDF is never saved against
 * the wrong identity.
 *
 * Additive to the structured syllabus: attaching this PDF never touches
 * semester/subject records, and deleting structured records never touches it.
 *
 * Storage reuses the existing GridFS flow (uploadSyllabusPdf + the
 * /api/admin/programme-syllabus route); no separate PDF system is introduced.
 *
 * LEGACY: programme documents written before the integration carry no academic
 * session. They are listed separately and can be removed, but are never
 * attributed to a session here.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Trash2 } from "lucide-react";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import SearchableSelect from "@/components/ui/searchable-select";
import PdfAttachmentField from "./pdf-attachment-field";
import AddStructureModal, {
  type AddStructurePrefill,
} from "./add-structure-modal";
import {
  deleteProgrammeSyllabus,
  readUploadedPdf,
  saveProgrammeSyllabus,
  uploadSyllabusPdf,
  validatePdfFile,
  type CatalogueProgramme,
} from "./syllabus-api";
import { buildProgrammeOptions, buildSessionOptions } from "./programme-options";
import { identityLabel, type ProgrammeSyllabusRecord } from "./types";
import styles from "./syllabus.module.css";
import type { ProgrammeStructureSummary } from "@/components/academic-structure/types";

interface ProgrammeSyllabusPdfCardProps {
  /** Programme structures to choose from (the academic identities). */
  structures: ProgrammeStructureSummary[];
  /** The existing programme catalogue (public discovery), unioned with `structures`. */
  catalogue?: CatalogueProgramme[];
  /** Programme-level documents, to display the current PDF. */
  docs: ProgrammeSyllabusRecord[];
  /** Structure list loading / error state, surfaced inside the selectors. */
  structuresLoading?: boolean;
  structuresError?: string;
  onRetryStructures?: () => void;
  /** Reload the shared structure list after an explicit create. */
  onRefreshStructures?: () => Promise<void> | void;
  /** Called after a successful save/delete so the parent can refresh. */
  onChanged: () => void | Promise<void>;
}

export default function ProgrammeSyllabusPdfCard({
  structures,
  catalogue = [],
  docs,
  structuresLoading = false,
  structuresError = "",
  onRetryStructures,
  onRefreshStructures,
  onChanged,
}: ProgrammeSyllabusPdfCardProps) {
  const router = useRouter();
  const [programme, setProgramme] = useState("");
  const [session, setSession] = useState("");
  const [structureModal, setStructureModal] = useState<{
    prefill: AddStructurePrefill;
    lockProgramme: boolean;
  } | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [legacyTarget, setLegacyTarget] = useState<ProgrammeSyllabusRecord | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const programmeOptions = buildProgrammeOptions(structures, catalogue);
  const sessionOptions = buildSessionOptions(structures, programme);

  // Programme chosen but no academic structure configured anywhere: the one
  // honest state — no session is invented and no PDF can be attached.
  const structureNotConfigured =
    !!programme &&
    !structuresLoading &&
    !structuresError &&
    sessionOptions.length === 0;

  const structure =
    structures.find(
      (entry) =>
        entry.programmeCode.toUpperCase() === programme.toUpperCase() &&
        entry.academicSession === session
    ) ?? null;

  /** Name of a programme from whichever source knows it ('' when unknown). */
  function programmeNameOf(code: string): string {
    return (
      catalogue.find(
        (entry) => entry.programmeCode.toUpperCase() === code.toUpperCase()
      )?.programmeName ??
      structures.find(
        (entry) => entry.programmeCode.toUpperCase() === code.toUpperCase()
      )?.programmeName ??
      ""
    );
  }

  const doc = structure
    ? docs.find(
        (d) =>
          d.programme === structure.programmeCode &&
          d.academicSession === structure.academicSession
      ) ?? null
    : null;
  const currentUrl = doc?.pdfUrl ?? null;
  const currentName = doc?.pdfName ?? null;
  const isActive = structure?.status === "ACTIVE";

  const legacyDocs = docs.filter((d) => d.academicSession === null);

  /**
   * A PDF belongs to one academic identity — drop any pending selection when
   * the identity changes so it can never be saved against the wrong one.
   */
  function resetPending() {
    setPdfFile(null);
    setError("");
    setSuccess("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleProgrammeChange(value: string) {
    setProgramme(value);
    setSession("");
    resetPending();
  }

  function handleSessionChange(value: string) {
    setSession(value);
    resetPending();
  }

  /** "+ Add New Programme": the existing Academic Structure create form. */
  function openAddProgramme(query: string) {
    setStructureModal({
      prefill: {
        programmeCode: query.trim().toUpperCase(),
        programmeName: "",
        academicSession: "",
      },
      lockProgramme: false,
    });
  }

  /** "+ Add New Academic Session": same form, locked to this programme. */
  function openAddSession() {
    if (!programme) return;
    setStructureModal({
      prefill: {
        programmeCode: programme,
        programmeName: programmeNameOf(programme),
        academicSession: "",
      },
      lockProgramme: true,
    });
  }

  function handleStructureCreated(created: {
    programmeCode: string;
    academicSession: string;
  }) {
    setStructureModal(null);
    setProgramme(created.programmeCode);
    setSession(created.academicSession);
    resetPending();
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

    if (!programme || !session || !structure) {
      setError("Select a programme and an academic session first.");
      return;
    }

    if (!isActive) {
      setError(
        "This academic structure is INACTIVE, so it cannot be selected for a new upload. Reactivate it in Academic Structure first."
      );
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
        structure.programmeCode,
        structure.academicSession,
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
    if (!structure || loading) return;
    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const outcome = await deleteProgrammeSyllabus(
        structure.programmeCode,
        structure.academicSession
      );
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

  async function handleRemoveLegacy() {
    const target = legacyTarget;
    if (!target) return;
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      // A legacy document is removed by omitting the session — no session is
      // ever guessed for it.
      const outcome = await deleteProgrammeSyllabus(target.programme, null);
      if (!outcome.success) {
        setError(outcome.message);
        return;
      }
      setSuccess("Legacy programme syllabus PDF removed.");
      await onChanged();
    } finally {
      setLoading(false);
      setLegacyTarget(null);
    }
  }

  return (
    <>
    <Card>
      <CardHeader
        title="Official Programme Syllabus"
        subtitle="Upload one official syllabus PDF for a ProgrammeStructure identity (programme + academic session). No semester or subject records are required."
      />

      <div className={styles.formFields}>
        <SearchableSelect
          id="programme-pdf-programme"
          label="Course / Programme"
          placeholder="Select a programme…"
          searchPlaceholder="Type a code (BCA) or name…"
          emptyMessage="No programmes are defined yet. Create one in Academic Structure first."
          noResultsMessage="No programme matches your search."
          value={programme}
          options={programmeOptions}
          onChange={handleProgrammeChange}
          disabled={loading}
          loading={structuresLoading}
          error={structuresError}
          onRetry={onRetryStructures}
          hint="Search the MSU programme catalogue. Academic details are managed in Academic Structure."
          footerAction={{ label: "Add New Programme", onClick: openAddProgramme }}
        />

        <SearchableSelect
          id="programme-pdf-session"
          label="Academic Session"
          placeholder={
            programme ? "Select an academic session…" : "Select a programme first"
          }
          searchPlaceholder="Type a session (2023-24)…"
          emptyMessage={
            programme
              ? "This programme has no academic sessions defined yet."
              : "Select a programme first."
          }
          noResultsMessage="No academic session matches your search."
          value={session}
          options={sessionOptions}
          onChange={handleSessionChange}
          disabled={loading || !programme}
          footerAction={
            programme
              ? { label: "Add New Academic Session", onClick: openAddSession }
              : undefined
          }
        />

        {structureNotConfigured && (
          <div className={styles.structureMissing} role="note">
            <p>
              <strong>{programme}</strong> exists in the programme catalogue, but
              its academic structure has not been configured yet, so no academic
              session can be chosen and no PDF can be attached to it.
            </p>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => router.push("/admin/academic-structure")}
            >
              Configure Academic Structure
            </Button>
          </div>
        )}

        <div className={styles.formField}>
          <label>Official Syllabus PDF</label>
          <PdfAttachmentField
            currentUrl={currentUrl}
            currentName={currentName}
            pendingFile={pdfFile}
            badge="Official"
            emptyHint={
              structure
                ? "No official programme PDF attached"
                : "Select a programme and academic session first"
            }
            chooseLabel="Choose PDF"
            replaceLabel="Replace"
            uploading={uploading}
            disabled={loading}
            disableUpload={!!structure && !isActive}
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

      {structure && !isActive && (
        <p className={styles.cardNote} role="note">
          This academic structure is INACTIVE. It is a historical curriculum: it
          is not offered for a new upload. Any document already attached stays
          readable and can still be removed.
        </p>
      )}

      {error && <p className={styles.formError}>{error}</p>}
      {success && <p className={styles.formSuccess}>{success}</p>}

      <div className={styles.saveRow}>
        <p className={styles.cardNote}>
          This PDF is the official syllabus document for the{" "}
          <strong>whole programme</strong> in one academic session and is shown to
          students even when no semester or subject records exist. Removing it
          does not affect the structured syllabus.
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleSave}
          loading={loading}
          disabled={!structure || !isActive}
        >
          Save
        </Button>
      </div>

      {legacyDocs.length > 0 && (
        <div className={styles.legacyBlock}>
          <p className={styles.cardNote} role="note">
            <FileText size={13} /> Legacy programme documents (created before
            academic sessions). They are read-only history and are never
            attributed to a session; removing one only deletes that document.
          </p>
          <ul className={styles.legacyList}>
            {legacyDocs.map((d) => (
              <li key={d.id}>
                <span>
                  {identityLabel(d.programme, d.academicSession)}
                  {d.pdfName ? ` · ${d.pdfName}` : ""}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  title="Remove legacy programme PDF"
                  aria-label={`Remove legacy ${d.programme} programme PDF`}
                  disabled={loading}
                  onClick={() => setLegacyTarget(d)}
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          if (!loading) setConfirmOpen(false);
        }}
        onConfirm={handleRemove}
        title="Delete Official Programme PDF"
        description={
          structure
            ? `Delete the official ${identityLabel(
                structure.programmeCode,
                structure.academicSession
              )} syllabus PDF? Semesters, subjects and the structured syllabus are NOT deleted.`
            : ""
        }
        confirmLabel="Delete PDF"
        variant="danger"
        loading={loading}
      />

      <ConfirmDialog
        open={!!legacyTarget}
        onClose={() => {
          if (!loading) setLegacyTarget(null);
        }}
        onConfirm={handleRemoveLegacy}
        title="Delete legacy programme PDF"
        description={
          legacyTarget
            ? `Delete the legacy ${legacyTarget.programme} programme PDF? This is a session-less historical document; no session is assigned to it. Structured records are not affected.`
            : ""
        }
        confirmLabel="Delete PDF"
        variant="danger"
        loading={loading}
      />
    </Card>

    {/* The EXPLICIT create step, rendered as a sibling of the card's own
        dialogs so it is never clipped. Reuses the Academic Structure form. */}
    <AddStructureModal
      open={!!structureModal}
      prefill={
        structureModal?.prefill ?? {
          programmeCode: "",
          programmeName: "",
          academicSession: "",
        }
      }
      lockProgramme={structureModal?.lockProgramme ?? false}
      onClose={() => setStructureModal(null)}
      onRefresh={() => onRefreshStructures?.()}
      onCreated={handleStructureCreated}
    />
    </>
  );
}
