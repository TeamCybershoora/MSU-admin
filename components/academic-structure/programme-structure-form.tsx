"use client";

/**
 * ProgrammeStructureForm — CREATE a programme structure, or EDIT its metadata.
 *
 * The curriculum (semesters and subjects) is managed on the manage page, so this
 * form only carries the identity of the curriculum:
 *   programmeCode + academicSession  → the key Syllabus and Result will use
 *   programmeName                    → display label
 *   status                           → ACTIVE / INACTIVE
 *
 * In EDIT mode the programme code and academic session are shown read-only: the
 * server rejects changing them because they identify the curriculum that future
 * modules address. A corrected curriculum is a new structure; the old one is
 * deactivated instead of rewritten.
 */

import { useState } from "react";
import Modal, { ModalScrollable } from "@/components/ui/modal";
import Button from "@/components/ui/button";
import {
  ACADEMIC_SESSION_PATTERN,
  STRUCTURE_STATUSES,
  type ProgrammeStructureStatus,
} from "@/lib/programme-structure";
import type { ApiOutcome } from "./academic-structure-api";
import styles from "./academic-structure.module.css";

export interface ProgrammeStructureFormValues {
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: ProgrammeStructureStatus;
}

/**
 * The fields this form reads — satisfied by both the list summary and the full
 * manage-page record, so the same modal serves both pages.
 */
export interface ProgrammeStructureFormRecord {
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: ProgrammeStructureStatus;
}

interface ProgrammeStructureFormProps {
  open: boolean;
  mode: "create" | "edit";
  record: ProgrammeStructureFormRecord | null;
  /**
   * CREATE only: lock the programme code + name so a new academic session is
   * always created for the programme the caller is already looking at. Used by
   * the Syllabus selector's "Add New Academic Session" flow, which must never
   * let a session be created under a different programme. Ignored in edit mode
   * (the identity is already fixed there).
   */
  lockProgramme?: boolean;
  onClose: () => void;
  onSave: (values: ProgrammeStructureFormValues) => Promise<ApiOutcome>;
}

export default function ProgrammeStructureForm({
  open,
  mode,
  record,
  lockProgramme = false,
  onClose,
  onSave,
}: ProgrammeStructureFormProps) {
  const [programmeCode, setProgrammeCode] = useState("");
  const [programmeName, setProgrammeName] = useState("");
  const [academicSession, setAcademicSession] = useState("");
  const [status, setStatus] = useState<ProgrammeStructureStatus>("ACTIVE");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset the form each time it is opened (or the edited record changes).
  // Adjusted during render rather than in an effect: the reset is derived purely
  // from props, so React applies it in the same pass and `resetFor` converges
  // immediately (it only changes when the parent opens the modal or swaps the
  // record).
  const [resetFor, setResetFor] = useState<{
    open: boolean;
    record: ProgrammeStructureFormRecord | null;
  }>({ open, record });

  if (resetFor.open !== open || resetFor.record !== record) {
    setResetFor({ open, record });
    if (open) {
      setProgrammeCode(record?.programmeCode ?? "");
      setProgrammeName(record?.programmeName ?? "");
      setAcademicSession(record?.academicSession ?? "");
      setStatus(record?.status ?? "ACTIVE");
      setSaving(false);
      setError("");
    }
  }

  const isEdit = mode === "edit";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    const code = programmeCode.trim().toUpperCase();
    const name = programmeName.trim();
    const session = academicSession.trim();

    if (!code) {
      setError("Programme code is required.");
      return;
    }
    if (!name) {
      setError("Programme name is required.");
      return;
    }
    if (!ACADEMIC_SESSION_PATTERN.test(session)) {
      setError("Academic session must look like 2025-26.");
      return;
    }

    setSaving(true);
    setError("");

    const outcome = await onSave({
      programmeCode: code,
      programmeName: name,
      academicSession: session,
      status,
    });

    setSaving(false);
    // On success the parent closes the modal.
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
            {isEdit ? "Edit Programme Structure" : "Add Programme Structure"}
          </h3>
          <p className={styles.modalDesc}>
            {isEdit
              ? "Update the programme name or status. Programme code and academic session identify the curriculum and cannot be changed."
              : "A programme structure is the master definition of what is taught. Semesters and subjects are added next."}
          </p>

          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="structure-code">Programme Code *</label>
              <input
                id="structure-code"
                type="text"
                placeholder="e.g. BCA"
                value={programmeCode}
                onChange={(e) => setProgrammeCode(e.target.value)}
                disabled={saving || isEdit || lockProgramme}
                required
              />
              {isEdit ? (
                <span className={styles.formHint}>
                  Fixed identity — Syllabus and Result address this curriculum by
                  programme code + academic session.
                </span>
              ) : lockProgramme ? (
                <span className={styles.formHint}>
                  Fixed — the new academic session is created for this programme.
                </span>
              ) : null}
            </div>

            <div className={styles.formField}>
              <label htmlFor="structure-name">Programme Name *</label>
              <input
                id="structure-name"
                type="text"
                placeholder="e.g. Bachelor of Computer Applications"
                value={programmeName}
                onChange={(e) => setProgrammeName(e.target.value)}
                disabled={saving || (lockProgramme && !isEdit)}
                required
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="structure-session">Academic Session *</label>
              <input
                id="structure-session"
                type="text"
                placeholder="e.g. 2025-26"
                value={academicSession}
                onChange={(e) => setAcademicSession(e.target.value)}
                disabled={saving || isEdit}
                required
              />
              {isEdit && (
                <span className={styles.formHint}>
                  Fixed identity — one curriculum exists per programme + academic
                  session.
                </span>
              )}
            </div>

            <div className={styles.formField}>
              <label htmlFor="structure-status">Status</label>
              <select
                id="structure-status"
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
                INACTIVE keeps every record intact but makes the whole structure
                unavailable for new Syllabus and Result selection.
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
            {isEdit ? "Save Changes" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
