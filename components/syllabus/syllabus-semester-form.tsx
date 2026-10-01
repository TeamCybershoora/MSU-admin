"use client";

/**
 * SyllabusSemesterForm — add a semester document, or edit an existing one.
 *
 * The academic identity is chosen from Academic Structure, never typed:
 *
 *   Programme  →  Academic Session  →  Semester
 *
 * The programme and the academic session are TWO separate searchable selectors
 * (SearchableSelect), so the administrator can type a programme code (BCA) or a
 * programme name while the session list stays scoped to the chosen programme.
 * Only a real structure may be selected — typed text alone is never a value.
 *
 * When the programme changes, the previously chosen session and semester are
 * cleared and the session list is rebuilt for the new programme; when the
 * session changes, the semester (and its dependent document identity) is
 * cleared. This makes it impossible to submit a programme/session combination
 * that does not exist or to keep a session that is not valid for the new
 * programme.
 *
 * Only EFFECTIVELY ACTIVE structures and semesters can be selected for a new
 * upload (see lib/programme-structure effectiveStatus). In EDIT mode the
 * identity is fixed; only the semester number (a renumber inside the same
 * structure) and the semester-level PDF can change.
 *
 * The subject list of a semester document is managed per subject from the
 * semester card, so an edit here can never overwrite unrelated subjects.
 *
 * PDF bytes are stored through the shared uploadSyllabusPdf helper; the parent
 * persists the reference with the generic create/update API call.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Modal, { ModalScrollable } from "@/components/ui/modal";
import Button from "@/components/ui/button";
import SearchableSelect from "@/components/ui/searchable-select";
import PdfAttachmentField from "./pdf-attachment-field";
import AddStructureModal, {
  type AddStructurePrefill,
} from "./add-structure-modal";
import {
  readUploadedPdf,
  uploadSyllabusPdf,
  validatePdfFile,
  type ApiOutcome,
  type CatalogueProgramme,
} from "./syllabus-api";
import { identityLabel, type SyllabusRecord } from "./types";
import { fetchProgrammeStructure } from "@/components/academic-structure/academic-structure-api";
import { effectiveStatus } from "@/lib/programme-structure";
import {
  buildProgrammeOptions,
  buildSessionOptions,
  findStructure,
  sameProgramme,
} from "./programme-options";
import {
  semesterLabel,
  type CurriculumSemester,
  type ProgrammeStructureRecord,
  type ProgrammeStructureSummary,
} from "@/components/academic-structure/types";
import styles from "./syllabus.module.css";

/** Values handed to the parent, which performs the actual API call. */
export interface SemesterFormValues {
  programme: string;
  academicSession: string;
  semester: number;
  /** `undefined` = leave the existing attachment untouched. */
  pdfUrl?: string | null;
  pdfName?: string | null;
}

interface SyllabusSemesterFormProps {
  open: boolean;
  mode: "create" | "edit";
  /** Semester document being edited (edit mode). */
  record: SyllabusRecord | null;
  /** Academic structures offered as the identity selector. */
  structures: ProgrammeStructureSummary[];
  /** The existing programme catalogue (public discovery), unioned with `structures`. */
  catalogue?: CatalogueProgramme[];
  /** Structure list loading / error state, surfaced inside the selectors. */
  structuresLoading?: boolean;
  structuresError?: string;
  onRetryStructures?: () => void;
  /** Reload the shared structure list after an explicit create. */
  onRefreshStructures?: () => Promise<void> | void;
  onClose: () => void;
  onSave: (values: SemesterFormValues) => Promise<ApiOutcome>;
}

export default function SyllabusSemesterForm({
  open,
  mode,
  record,
  structures,
  catalogue = [],
  structuresLoading = false,
  structuresError = "",
  onRetryStructures,
  onRefreshStructures,
  onClose,
  onSave,
}: SyllabusSemesterFormProps) {
  const router = useRouter();
  const [programme, setProgramme] = useState("");
  const [session, setSession] = useState("");
  const [detail, setDetail] = useState<ProgrammeStructureRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [semester, setSemester] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfCleared, setPdfCleared] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  // The explicit create step behind "+ Add New Programme" / "+ Add New
  // Academic Session" — null when no create form is open.
  const [structureModal, setStructureModal] = useState<{
    prefill: AddStructurePrefill;
    lockProgramme: boolean;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset the form whenever it is opened, or the record/mode changes — derived
  // purely from props, so it is adjusted during render rather than in an effect.
  const [resetFor, setResetFor] = useState<{
    open: boolean;
    mode: "create" | "edit";
    record: SyllabusRecord | null;
  }>({ open, mode, record });

  if (
    resetFor.open !== open ||
    resetFor.mode !== mode ||
    resetFor.record !== record
  ) {
    setResetFor({ open, mode, record });
    if (open) {
      setProgramme(record?.programme ?? "");
      setSession(record?.academicSession ?? "");
      setDetail(null);
      setDetailError("");
      setSemester(record ? String(record.semester) : "");
      setPdfFile(null);
      setPdfCleared(false);
      setSubmitting(false);
      setUploading(false);
      setError("");
    }
  }

  // Programmes offered by the selector: the existing catalogue UNION the real
  // structures, so a catalogue-only programme stays selectable and can show the
  // "not configured" state instead of being hidden.
  const programmeOptions = useMemo(
    () => buildProgrammeOptions(structures, catalogue),
    [structures, catalogue]
  );

  // Academic sessions available FOR THE SELECTED PROGRAMME, newest first.
  const sessionOptions = useMemo(
    () => buildSessionOptions(structures, programme),
    [structures, programme]
  );

  // The structure selected by the (programme, session) pair — the ONE identity
  // the document will be attached to.
  const selectedStructure = useMemo(
    () => findStructure(structures, programme, session),
    [structures, programme, session]
  );
  const structureId = selectedStructure?.id ?? "";

  // A programme is selected but has NO structure at all: it exists in the
  // catalogue yet its academic structure was never configured. This is the one
  // honest state — no session is invented and no document can be attached.
  const structureNotConfigured =
    !!programme &&
    !structuresLoading &&
    !structuresError &&
    sessionOptions.length === 0;

  /** Name of a programme from whichever source knows it ('' when unknown). */
  function programmeNameOf(code: string): string {
    return (
      catalogue.find((entry) => sameProgramme(entry.programmeCode, code))
        ?.programmeName ??
      structures.find((structure) => sameProgramme(structure.programmeCode, code))
        ?.programmeName ??
      ""
    );
  }

  // Load the selected structure's curriculum (semesters) for the selector.
  // setState happens in the promise callback, not synchronously in the effect.
  useEffect(() => {
    if (!open || !structureId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailLoading(true);
    setDetailError("");

    fetchProgrammeStructure(structureId)
      .then((loaded) => {
        if (cancelled) return;
        setDetail(loaded);
        setDetailLoading(false);
        if (!loaded) {
          setDetailError("Unable to load this academic structure.");
          return;
        }
        // In create mode, default to the first selectable semester.
        if (mode === "create") {
          const first = selectableSemesters(loaded)[0];
          setSemester(first ? String(first.semesterNumber) : "");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
        setDetailLoading(false);
        setDetailError("Unable to load this academic structure.");
      });

    return () => {
      cancelled = true;
    };
  }, [open, structureId, mode]);

  // Keep the raw file input element in sync when the modal is re-opened.
  useEffect(() => {
    if (!open) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [open, mode, record]);

  const isCreate = mode === "create";
  const currentPdfUrl = pdfCleared ? null : record?.pdfUrl ?? null;
  const currentPdfName = pdfCleared ? null : record?.pdfName ?? null;

  const structureActive = detail?.status === "ACTIVE";
  // Editing an EXISTING document of an INACTIVE structure: no new upload, but
  // the existing attachment can still be cleared.
  const uploadBlocked =
    !isCreate && detail !== null && detail.status === "INACTIVE";

  const semesterOptions = detail
    ? isCreate
      ? selectableSemesters(detail)
      : allSemesters(detail)
    : [];

  /** Changing the programme invalidates the session and everything below it. */
  function handleProgrammeChange(value: string) {
    setProgramme(value);
    setSession("");
    setDetail(null);
    setDetailError("");
    setSemester("");
    setError("");
  }

  /** Changing the session invalidates the semester and the document identity. */
  function handleSessionChange(value: string) {
    setSession(value);
    setDetail(null);
    setDetailError("");
    setSemester("");
    setError("");
  }

  /**
   * "+ Add New Programme": open the EXISTING Academic Structure create form,
   * prefilled with the code the administrator typed. The programme code is
   * only committed when that form is submitted.
   */
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

  /**
   * "+ Add New Academic Session": open the same existing create form, but locked
   * to the programme already selected, so the new session can only belong to it.
   */
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

  /** The create form succeeded and the shared list has been refreshed. */
  function handleStructureCreated(created: {
    programmeCode: string;
    academicSession: string;
  }) {
    setStructureModal(null);
    setProgramme(created.programmeCode);
    setSession(created.academicSession);
    setDetail(null);
    setDetailError("");
    setSemester("");
    setError("");
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
    if (submitting) return;

    if (!programme) {
      setError("Select a programme.");
      return;
    }
    if (!session) {
      setError("Select an academic session.");
      return;
    }
    if (!selectedStructure) {
      setError(
        "The selected programme and academic session do not match an academic structure."
      );
      return;
    }

    // Editing a legacy (session-less) record is not supported here.
    if (isCreate && !structureActive) {
      setError(
        "This academic structure is INACTIVE and cannot be selected for a new upload."
      );
      return;
    }

    const semesterNumber = Number(semester);
    if (!semesterNumber) {
      setError("Select a semester.");
      return;
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
      programme: selectedStructure.programmeCode,
      academicSession: selectedStructure.academicSession,
      semester: semesterNumber,
      pdfUrl,
      pdfName,
    });

    setSubmitting(false);
    if (!outcome.success) setError(outcome.message);
    // On success the parent closes the modal.
  }

  return (
    <>
    <Modal
      open={open}
      onClose={() => {
        // While the explicit create step is open, Escape/overlay belong to it.
        if (!submitting && !structureModal) onClose();
      }}
      maxWidth={560}
    >
      <form onSubmit={handleSubmit}>
        <ModalScrollable>
          <h3 className={styles.modalTitle}>
            {isCreate ? "Add Semester" : "Edit Semester"}
          </h3>
          <p className={styles.modalDesc}>
            {record
              ? `${identityLabel(record.programme, record.academicSession)} — Semester ${record.semester}`
              : "Attach a semester-level PDF to an existing academic structure."}
          </p>

          <div className={styles.formFields}>
            <SearchableSelect
              id="semester-programme"
              label="Course / Programme"
              required
              placeholder="Select a programme…"
              searchPlaceholder="Type a code (BCA) or name…"
              emptyMessage="No programmes are defined yet. Create one in Academic Structure first."
              noResultsMessage="No programme matches your search."
              value={programme}
              options={programmeOptions}
              onChange={handleProgrammeChange}
              disabled={submitting || !isCreate}
              loading={structuresLoading}
              error={structuresError}
              onRetry={onRetryStructures}
              hint="Search the MSU programme catalogue. Academic details are managed in Academic Structure."
              footerAction={
                isCreate
                  ? {
                      label: "Add New Programme",
                      onClick: openAddProgramme,
                    }
                  : undefined
              }
            />

            <SearchableSelect
              id="semester-session"
              label="Academic Session"
              required
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
              disabled={submitting || !isCreate || !programme}
              footerAction={
                isCreate && programme
                  ? {
                      label: "Add New Academic Session",
                      onClick: openAddSession,
                    }
                  : undefined
              }
            />

            {isCreate && structureNotConfigured && (
              <div className={styles.structureMissing} role="note">
                <p>
                  <strong>{programme}</strong> exists in the programme catalogue,
                  but its academic structure has not been configured yet, so no
                  academic session can be chosen. Semesters and subjects are
                  defined in Academic Structure and are never invented here.
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
              <label htmlFor="semester-number">Semester *</label>
              <select
                id="semester-number"
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
                disabled={submitting || !detail || detailLoading}
                required
              >
                <option value="">
                  {detailLoading
                    ? "Loading semesters…"
                    : detail
                      ? "Select a semester…"
                      : "Select a programme and academic session first"}
                </option>
                {semesterOptions.map((s) => (
                  <option key={s.semesterNumber} value={s.semesterNumber}>
                    {semesterLabel(s)}
                  </option>
                ))}
              </select>
              {detailError ? (
                <span className={styles.formHint} role="alert">
                  {detailError}
                </span>
              ) : (
                displaySemesterHelp(detail, isCreate, semesterOptions.length)
              )}
            </div>

            <div className={styles.formField}>
              <label>
                {isCreate
                  ? "Semester Syllabus PDF (optional)"
                  : "Semester Syllabus PDF"}
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
                disableUpload={uploadBlocked}
                allowRemove={!isCreate}
                onChoose={choosePdf}
                onCancelSelection={cancelPdfSelection}
                onRemove={removeAttachedPdf}
              />
              {uploadBlocked && (
                <span className={styles.formHint} role="note">
                  This academic structure is INACTIVE, so a new upload is not
                  offered. The attached PDF can still be removed.
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
            {uploading
              ? "Uploading…"
              : isCreate
                ? "Create Semester"
                : "Save Changes"}
          </Button>
        </div>
      </form>
    </Modal>

    {/* The EXPLICIT create step — reuses the existing Academic Structure form
        and API. Rendered as a SIBLING so it is never clipped by (or nested
        inside) the semester dialog. Nothing is created unless it is submitted. */}
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

/** Semesters offered for a new document: effectively active only. */
function selectableSemesters(
  source: ProgrammeStructureRecord
): CurriculumSemester[] {
  return [...(source.semesters ?? [])]
    .sort((a, b) => a.semesterNumber - b.semesterNumber)
    .filter((s) => effectiveStatus(source.status, s.status) === "ACTIVE");
}

/** All semesters of the structure (used for a renumber in edit mode). */
function allSemesters(source: ProgrammeStructureRecord): CurriculumSemester[] {
  return [...(source.semesters ?? [])].sort(
    (a, b) => a.semesterNumber - b.semesterNumber
  );
}

/** Contextual help under the semester selector. */
function displaySemesterHelp(
  detail: ProgrammeStructureRecord | null,
  isCreate: boolean,
  optionCount: number
) {
  if (!detail) return null;

  if (optionCount === 0) {
    return (
      <span className={styles.formHint}>
        This structure has no {isCreate ? "active " : ""}semesters defined yet.
        Add them in Academic Structure first.
      </span>
    );
  }

  return null;
}
