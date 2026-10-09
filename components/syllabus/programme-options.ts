"use client";

/**
 * Programme option assembly for the Syllabus selectors.
 *
 * The programme list is the UNION of:
 *
 *   1. the existing MSU programme catalogue (public /api/syllabus/programmes),
 *      which itself is DISCOVERED from stored ProgrammeStructure data plus any
 *      legacy syllabus-only programme code, and
 *   2. every ProgrammeStructure the admin catalogue API returned.
 *
 * Unioning the two means a catalogue-only programme (one that has legacy
 * documents but no structure yet) is still selectable, so Syllabus Management
 * can show the honest "Academic Structure not configured yet" state instead of
 * hiding the programme. Programme names come from whichever source knows them.
 *
 * Nothing is hardcoded and no option is invented: every entry is a code that
 * actually exists in the catalogue or in a real structure.
 */

import type { SearchableOption } from "@/components/ui/searchable-select";
import type { ProgrammeStructureSummary } from "@/components/academic-structure/types";
import type { CatalogueProgramme } from "./syllabus-api";

/** Two programme codes name the same programme (case-insensitive). */
export function sameProgramme(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** Build the deduplicated, sorted programme options for a searchable selector. */
export function buildProgrammeOptions(
  structures: ProgrammeStructureSummary[],
  catalogue: CatalogueProgramme[]
): SearchableOption[] {
  const names = new Map<string, string>();

  for (const structure of structures) {
    const code = structure.programmeCode;
    if (!code) continue;
    const existing = names.get(code);
    // Prefer a non-empty name from any source.
    if (existing === undefined || (!existing && structure.programmeName)) {
      names.set(code, structure.programmeName);
    }
  }

  for (const entry of catalogue) {
    const code = entry.programmeCode;
    if (!code) continue;
    const existing = names.get(code);
    if (existing === undefined || (!existing && entry.programmeName)) {
      names.set(code, entry.programmeName ?? "");
    }
  }

  return Array.from(names, ([code, name]) => ({
    value: code,
    label: code,
    description: name || undefined,
  })).sort((a, b) => a.value.localeCompare(b.value));
}

/** Academic sessions of one programme, newest first (deduplicated). */
export function buildSessionOptions(
  structures: ProgrammeStructureSummary[],
  programme: string
): SearchableOption[] {
  if (!programme) return [];
  const sessions = new Set<string>();
  for (const structure of structures) {
    if (sameProgramme(structure.programmeCode, programme)) {
      sessions.add(structure.academicSession);
    }
  }
  return Array.from(sessions)
    .sort((a, b) => b.localeCompare(a))
    .map((value) => ({ value, label: value }));
}

/** The structure matching a programme + session pair, or null when none exists. */
export function findStructure(
  structures: ProgrammeStructureSummary[],
  programme: string,
  session: string
): ProgrammeStructureSummary | null {
  if (!programme || !session) return null;
  return (
    structures.find(
      (structure) =>
        sameProgramme(structure.programmeCode, programme) &&
        structure.academicSession === session
    ) ?? null
  );
}
