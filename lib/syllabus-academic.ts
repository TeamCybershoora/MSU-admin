/**
 * Syllabus ↔ Academic Structure bridge (Phase 2A).
 *
 * ProgrammeStructure is the SINGLE SOURCE OF TRUTH for academic metadata.
 * Syllabus Management only attaches documents, so every admin syllabus write
 * resolves its academic identity here before anything is stored:
 *
 *   programmeCode + academicSession [+ semesterNumber] [+ subjectCode]
 *
 * The resolvers below:
 *   - reject a malformed programme / session / semester / subject with 400,
 *   - reject an identity that does not exist in ProgrammeStructure with 404,
 *   - optionally require the record to be EFFECTIVELY ACTIVE (effectiveStatus)
 *     for a new upload, so an inactive programme / semester / subject can never
 *     be selected for new documents while every stored record is left intact.
 *
 * Nothing here writes to the database, and the authoritative metadata returned
 * (programme name, subject name) is what the routes store — a client-sent name
 * is never trusted.
 */

import connectDB from "@/lib/mongodb";
import { parseProgrammeCode, parseSemesterNumber } from "@/lib/validation";
import {
  effectiveStatus,
  parseAcademicSession,
  type ProgrammeStructureStatus,
} from "@/lib/programme-structure";
import ProgrammeStructure, {
  type IProgrammeSemester,
  type IProgrammeSubject,
} from "@/models/ProgrammeStructure";

/** Result of an identity lookup: expected failures carry an HTTP status. */
export type IdentityResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

/** The academic structure as read for a consumer (no Mongo document methods). */
export interface AcademicStructureSnapshot {
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: ProgrammeStructureStatus;
  semesters: IProgrammeSemester[];
}

export interface ResolvedStructure {
  programmeCode: string;
  academicSession: string;
  structure: AcademicStructureSnapshot;
}

export interface ResolvedSemester {
  semesterNumber: number;
  semester: IProgrammeSemester;
}

export interface ResolvedSubject {
  subject: IProgrammeSubject;
}

function fail(status: number, message: string): IdentityResult<never> {
  return { ok: false, status, message };
}

/**
 * Resolve `programmeCode + academicSession` to the stored ProgrammeStructure.
 *
 * `requireActive` is used for NEW associations: an inactive structure is a
 * historical curriculum, and documents are never attached to it afresh.
 */
export async function resolveStructure(
  rawProgramme: unknown,
  rawSession: unknown,
  options?: { requireActive?: boolean }
): Promise<IdentityResult<ResolvedStructure>> {
  const programmeCode = parseProgrammeCode(rawProgramme);
  if (!programmeCode) {
    return fail(
      400,
      "A valid programme code is required (1-20 characters: letters, spaces, dots, ampersands or hyphens)."
    );
  }

  const academicSession = parseAcademicSession(rawSession);
  if (!academicSession) {
    return fail(400, "A valid academic session is required, in the form 2023-24.");
  }

  await connectDB();

  const found = (await ProgrammeStructure.findOne({
    programmeCode,
    academicSession,
  }).lean()) as unknown as AcademicStructureSnapshot | null;

  if (!found) {
    return fail(
      404,
      `No academic structure exists for ${programmeCode} (${academicSession}). Create it in Academic Structure first.`
    );
  }

  const structure: AcademicStructureSnapshot = {
    programmeCode: found.programmeCode,
    programmeName: found.programmeName,
    academicSession: found.academicSession,
    status: found.status,
    semesters: (found.semesters ?? []) as IProgrammeSemester[],
  };

  if (options?.requireActive && structure.status !== "ACTIVE") {
    return fail(
      409,
      `The ${programmeCode} (${academicSession}) academic structure is INACTIVE, so it cannot be selected for a new upload. Existing documents are kept. Reactivate the structure in Academic Structure to attach new documents.`
    );
  }

  return { ok: true, data: { programmeCode, academicSession, structure } };
}

/** Resolve a semester inside an already-loaded structure. */
export function resolveSemester(
  structure: AcademicStructureSnapshot,
  rawSemester: unknown,
  options?: { requireActive?: boolean }
): IdentityResult<ResolvedSemester> {
  const semesterNumber = parseSemesterNumber(rawSemester);
  if (semesterNumber === null) {
    return fail(400, "Semester must be a whole number between 1 and 12.");
  }

  const semester = structure.semesters.find(
    (entry) => entry.semesterNumber === semesterNumber
  );
  if (!semester) {
    return fail(
      404,
      `Semester ${semesterNumber} is not part of the ${structure.programmeCode} (${structure.academicSession}) academic structure.`
    );
  }

  if (
    options?.requireActive &&
    effectiveStatus(structure.status, semester.status) !== "ACTIVE"
  ) {
    return fail(
      409,
      `Semester ${semesterNumber} of ${structure.programmeCode} (${structure.academicSession}) is effectively INACTIVE, so it cannot be selected for a new upload.`
    );
  }

  return { ok: true, data: { semesterNumber, semester } };
}

/**
 * Resolve ONE subject inside a semester. The subject CODE is the identity; the
 * subject name and every other academic field are read from the structure.
 */
export function resolveSubject(
  structure: AcademicStructureSnapshot,
  semesterNumber: number,
  rawSubjectCode: unknown,
  options?: { requireActive?: boolean }
): IdentityResult<ResolvedSubject> {
  const semester = structure.semesters.find(
    (entry) => entry.semesterNumber === semesterNumber
  );
  if (!semester) {
    return fail(
      404,
      `Semester ${semesterNumber} is not part of the ${structure.programmeCode} (${structure.academicSession}) academic structure.`
    );
  }

  const subjectCode =
    typeof rawSubjectCode === "string" ? rawSubjectCode.trim().toUpperCase() : "";
  if (!subjectCode) {
    return fail(400, "A subject code is required.");
  }

  const subject = semester.subjects.find(
    (entry) => entry.subjectCode.toUpperCase() === subjectCode
  );
  if (!subject) {
    return fail(
      404,
      `Subject ${subjectCode} is not defined in Semester ${semesterNumber} of ${structure.programmeCode} (${structure.academicSession}).`
    );
  }

  if (options?.requireActive) {
    const semesterStatus = effectiveStatus(structure.status, semester.status);
    if (effectiveStatus(semesterStatus, subject.status) !== "ACTIVE") {
      return fail(
        409,
        `Subject ${subjectCode} is effectively INACTIVE, so it cannot be selected for a new upload.`
      );
    }
    return { ok: true, data: { subject } };
  }

  return { ok: true, data: { subject } };
}

/**
 * Subjects of one semester that are effectively ACTIVE — the exact set the
 * Syllabus UI offers for a new subject association. Order is the structure's
 * stored order.
 */
export function listActiveSubjects(
  structure: AcademicStructureSnapshot,
  semesterNumber: number
): IProgrammeSubject[] {
  const semester = structure.semesters.find(
    (entry) => entry.semesterNumber === semesterNumber
  );
  if (!semester) return [];

  const semesterStatus = effectiveStatus(structure.status, semester.status);
  return semester.subjects.filter(
    (subject) => effectiveStatus(semesterStatus, subject.status) === "ACTIVE"
  );
}
