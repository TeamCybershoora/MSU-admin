"use client";

/**
 * AddStructureModal — the EXPLICIT create step behind "+ Add New Programme"
 * and "+ Add New Academic Session" in Syllabus Management.
 *
 * It does not introduce a second curriculum editor: it wraps the SAME
 * ProgrammeStructureForm and the SAME POST /api/admin/academic-structure call
 * the Academic Structure page uses. In this architecture a programme has no
 * separate record — a ProgrammeStructure (programmeCode + academicSession) IS
 * how a programme/session becomes real and how it appears in the catalogue — so
 * creating one is the correct, existing way to add either.
 *
 * The caller supplies a prefill (the code/name the administrator searched for)
 * and may lock the programme, so a new session can only be created for the
 * programme already selected. Nothing is created unless the administrator
 * explicitly submits this form.
 */

import { useMemo } from "react";
import ProgrammeStructureForm from "@/components/academic-structure/programme-structure-form";
import { createProgrammeStructure } from "@/components/academic-structure/academic-structure-api";
import type { ApiOutcome } from "@/components/academic-structure/academic-structure-api";

export interface AddStructurePrefill {
  programmeCode: string;
  programmeName: string;
  academicSession: string;
}

interface AddStructureModalProps {
  open: boolean;
  prefill: AddStructurePrefill;
  /** Lock the programme code + name (used by "Add New Academic Session"). */
  lockProgramme?: boolean;
  onClose: () => void;
  /** Refresh the shared structures list before the new option is selected. */
  onRefresh: () => Promise<void> | void;
  /** Called after a successful create so the caller can select the new option. */
  onCreated: (created: {
    programmeCode: string;
    academicSession: string;
  }) => void;
}

export default function AddStructureModal({
  open,
  prefill,
  lockProgramme = false,
  onClose,
  onRefresh,
  onCreated,
}: AddStructureModalProps) {
  // Stable record identity: ProgrammeStructureForm resets itself when the
  // `record` prop changes, so it must not be rebuilt on every render.
  const record = useMemo(
    () =>
      open
        ? {
            programmeCode: prefill.programmeCode,
            programmeName: prefill.programmeName,
            academicSession: prefill.academicSession,
            status: "ACTIVE" as const,
          }
        : null,
    [open, prefill.programmeCode, prefill.programmeName, prefill.academicSession]
  );

  async function handleSave(values: {
    programmeCode: string;
    programmeName: string;
    academicSession: string;
    status: "ACTIVE" | "INACTIVE";
  }): Promise<ApiOutcome> {
    const outcome = await createProgrammeStructure(values);
    if (outcome.success) {
      // Make sure the new structure exists in the shared list before the caller
      // selects it — the selector resolves sessions from that list.
      await onRefresh();
      onCreated({
        programmeCode: values.programmeCode,
        academicSession: values.academicSession,
      });
    }
    return outcome;
  }

  return (
    <ProgrammeStructureForm
      open={open}
      mode="create"
      record={record}
      lockProgramme={lockProgramme}
      onClose={onClose}
      onSave={handleSave}
    />
  );
}
