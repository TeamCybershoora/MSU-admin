/**
 * Public, read-only syllabus query layer.
 *
 * This module is the ONLY place the public syllabus API reads curriculum and
 * document data. Route handlers are thin wrappers around these functions, so
 * the exact same validation and query rules run in production and in the test
 * script (scripts/test-public-syllabus.ts).
 *
 * Architectural rules encoded here:
 *
 * - academicSession IS PART OF THE SYLLABUS IDENTITY. The public identity is
 *   programmeCode + academicSession (+ semesterNumber when a semester is
 *   requested). Every database query below includes academicSession whenever a
 *   session is known — a request without a valid session is rejected with 400
 *   rather than silently falling back to "any session".
 *
 * - Sessions are DISCOVERED from stored ProgrammeStructure data. Nothing in
 *   this module (or the UI built on it) hardcodes a session such as 2023-24.
 *
 * - Documents written by the integrated admin flow ARE session-scoped: the
 *   exact identity (programmeCode + academicSession) is looked up first, so a
 *   newly attached document is published under its own session.
 *
 * - Documents that PREDATE academic sessions carry no academicSession field
 *   (null). Such a legacy document is attributed to the requested session ONLY
 *   while the programme has exactly one known session — attribution is then
 *   unambiguous. With two or more sessions the document's owner is unknown, so
 *   it is WITHHELD (reported via `legacyDocumentWithheld`) instead of being
 *   shown under a possibly-wrong session. Legacy records are never rewritten:
 *   they are read with `academicSession: null` and can be migrated separately.
 *
 * - Document visibility never depends on a status field: the legacy Syllabus
 *   collections have no publication/status concept, so an INACTIVE academic
 *   structure does not hide already-published documents. Structure status only
 *   gates SUBJECT metadata, through the established effective-status contract
 *   (listSelectableSubjects).
 */

import connectDB from "@/lib/mongodb";
import { parseProgrammeCode, parseSemesterNumber } from "@/lib/validation";
import { parseAcademicSession } from "@/lib/programme-structure";
import ProgrammeStructure, {
  listSelectableSubjects,
  type IProgrammeStructure,
} from "@/models/ProgrammeStructure";
import Syllabus, { toSafeSyllabus } from "@/models/Syllabus";
import ProgrammeSyllabus, {
  toSafeProgrammeSyllabus,
} from "@/models/ProgrammeSyllabus";

/* ── Result shapes shared with the public API ───────────────────── */

/** Discriminated result — expected failures carry an HTTP status + message. */
export type PublicApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

function ok<T>(data: T): PublicApiResult<T> {
  return { ok: true, data };
}

function fail(status: number, message: string): PublicApiResult<never> {
  return { ok: false, status, message };
}

/** One public programme option. `programmeName` is null for legacy-only codes. */
export interface PublicProgramme {
  programmeCode: string;
  programmeName: string | null;
}

/** One discoverable academic session, with its stored structure status. */
export interface PublicSession {
  academicSession: string;
  status: "ACTIVE" | "INACTIVE";
}

/** One semester entry of a structure, without the subject list. */
export interface PublicSemesterSummary {
  semesterNumber: number;
  semesterName: string;
  status: "ACTIVE" | "INACTIVE";
  /** Effectively-active subjects (0 when the semester/structure is inactive). */
  subjectCount: number;
}

export interface PublicSyllabusProgramme {
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: "ACTIVE" | "INACTIVE";
  semesterCount: number;
}

/**
 * One subject as exposed publicly: the same shape listSelectableSubjects
 * returns (and therefore structurally identical to the admin curriculum type),
 * so the UI can reuse the existing display helpers without duplication.
 */
export type PublicSubject = ReturnType<typeof listSelectableSubjects>[number];

/** Semester-wise document for the requested identity (legacy record, unscoped). */
export type PublicSemesterDocument = ReturnType<typeof toSafeSyllabus>;

/** Programme-wide official document (legacy record, unscoped). */
export type PublicProgrammeDocument = ReturnType<
  typeof toSafeProgrammeSyllabus
>;

export interface PublicSyllabusDetail {
  programme: PublicSyllabusProgramme;
  semesters: PublicSemesterSummary[];
  /** Present only when a valid semester was requested. */
  semester: {
    semesterNumber: number;
    semesterName: string;
    status: "ACTIVE" | "INACTIVE";
    subjects: PublicSubject[];
  } | null;
  /** Semester-wise PDF/subjects record — only when a semester was requested. */
  syllabus: PublicSemesterDocument | null;
  /** Programme-wide official PDF record (always resolved for the session). */
  programmeDocument: PublicProgrammeDocument | null;
  /**
   * True when a legacy document exists for this selection but could not be
   * attributed to an academic session (programme has 2+ sessions and the
   * records carry no session field). Surfaced so the UI can explain the gap
   * instead of silently showing nothing.
   */
  legacyDocumentWithheld: boolean;
}

/* ── Programme discovery ────────────────────────────────────────── */

/**
 * Programmes the public syllabus UI may offer: every ProgrammeStructure code
 * plus any legacy syllabus-only programme, so a programme whose documents
 * predate the academic structure is not made invisible. Pure discovery — no
 * status filtering, because documents have no status and historical sessions
 * must remain reachable.
 */
export async function listPublicProgrammes(): Promise<
  PublicApiResult<PublicProgramme[]>
> {
  await connectDB();

  const structures = await ProgrammeStructure.find({})
    .select("programmeCode programmeName")
    .sort({ programmeCode: 1 })
    .lean();

  const names = new Map<string, string>();
  for (const structure of structures) {
    if (!names.has(structure.programmeCode)) {
      names.set(structure.programmeCode, structure.programmeName);
    }
  }

  // Legacy collections may be empty (or not yet created) — never fatal here.
  const codes = new Set<string>(names.keys());
  try {
    for (const code of await Syllabus.distinct("programme")) codes.add(code);
  } catch {
    /* collection absent/empty — nothing to add */
  }
  try {
    for (const code of await ProgrammeSyllabus.distinct("programme"))
      codes.add(code);
  } catch {
    /* collection absent/empty — nothing to add */
  }

  return ok(
    Array.from(codes)
      .sort()
      .map((programmeCode) => ({
        programmeCode,
        programmeName: names.get(programmeCode) ?? null,
      }))
  );
}

/* ── Session discovery ──────────────────────────────────────────── */

/**
 * Academic sessions that actually exist for a programme, derived from stored
 * ProgrammeStructure data (never hardcoded). An unknown-but-well-formed
 * programme yields a clean empty list; a malformed code is rejected with 400.
 * Both statuses are returned: an INACTIVE structure is a historical session,
 * and hiding it would strand its published documents.
 */
export async function listPublicSessions(
  rawProgramme: unknown
): Promise<PublicApiResult<PublicSession[]>> {
  const programmeCode = parseProgrammeCode(rawProgramme);
  if (!programmeCode) {
    return fail(400, "Provide a valid programme code.");
  }

  await connectDB();

  // Unique index { programmeCode, academicSession } ⇒ one document per session.
  const structures = await ProgrammeStructure.find({ programmeCode })
    .select("academicSession status")
    .sort({ academicSession: 1 })
    .lean();

  return ok(
    structures.map((structure) => ({
      academicSession: structure.academicSession,
      status: structure.status,
    }))
  );
}

/* ── Session-aware syllabus lookup ──────────────────────────────── */

/**
 * Legacy documents carry no session — see the module header for the
 * single-session attribution rule. Returns false once a programme has 2+
 * sessions, in which case legacy records are withheld rather than guessed.
 */
async function legacyDocumentsAttributable(
  programmeCode: string
): Promise<boolean> {
  const sessionCount = await ProgrammeStructure.countDocuments({
    programmeCode,
  });
  return sessionCount === 1;
}

/** True when any legacy record exists that attribution had to withhold. */
async function legacyDocumentExists(
  programmeCode: string,
  semesterNumber: number | null
): Promise<boolean> {
  try {
    const programmeDoc = await ProgrammeSyllabus.findOne({
      programme: programmeCode,
      academicSession: null,
    }).select("_id");
    if (programmeDoc) return true;

    if (semesterNumber !== null) {
      const semesterDoc = await Syllabus.findOne({
        programme: programmeCode,
        academicSession: null,
        semester: semesterNumber,
      }).select("_id");
      if (semesterDoc) return true;
    }
  } catch {
    /* legacy collections absent — nothing can be withheld */
  }
  return false;
}

/**
 * Resolve the syllabus for exactly one academic identity:
 *   programmeCode + academicSession [+ semesterNumber]
 *
 * Validation failures → 400, unknown programme/session/semester → 404,
 * a session with no published document → 200 with `syllabus: null`
 * (a missing document is data, not an error). Unexpected database errors
 * throw and are mapped to a generic 500 by the route handler.
 */
export async function getPublicSyllabus(query: {
  programmeCode?: unknown;
  academicSession?: unknown;
  semester?: unknown;
}): Promise<PublicApiResult<PublicSyllabusDetail>> {
  const programmeCode = parseProgrammeCode(query.programmeCode);
  if (!programmeCode) {
    return fail(400, "Provide a valid programme code (programmeCode).");
  }

  // The session is REQUIRED — identity is never narrowed to session-less.
  const academicSession = parseAcademicSession(query.academicSession);
  if (!academicSession) {
    return fail(
      400,
      "Provide a valid academic session (academicSession), e.g. 2023-24."
    );
  }

  const rawSemester = query.semester;
  const semesterProvided =
    rawSemester !== undefined &&
    rawSemester !== null &&
    String(rawSemester).trim() !== "";
  let semesterNumber: number | null = null;
  if (semesterProvided) {
    semesterNumber = parseSemesterNumber(rawSemester);
    if (semesterNumber === null) {
      return fail(400, "semester must be a whole number between 1 and 12.");
    }
  }

  await connectDB();

  // Complete identity in one query — never programme + semester alone.
  const structure: IProgrammeStructure | null =
    await ProgrammeStructure.findOne({
      programmeCode,
      academicSession,
    });
  if (!structure) {
    return fail(
      404,
      `No syllabus information is available for ${programmeCode} (${academicSession}).`
    );
  }

  const semesters: PublicSemesterSummary[] = [...structure.semesters]
    .sort((a, b) => a.semesterNumber - b.semesterNumber)
    .map((semester) => ({
      semesterNumber: semester.semesterNumber,
      semesterName: semester.semesterName || "",
      status: semester.status,
      subjectCount: listSelectableSubjects(
        structure,
        semester.semesterNumber
      ).length,
    }));

  let semesterDetail: PublicSyllabusDetail["semester"] = null;
  if (semesterNumber !== null) {
    const semester = structure.semesters.find(
      (entry) => entry.semesterNumber === semesterNumber
    );
    if (!semester) {
      return fail(
        404,
        `Semester ${semesterNumber} is not part of the ${programmeCode} ${academicSession} curriculum.`
      );
    }

    // Effective-status contract: subjects of an inactive structure/semester
    // are not offered; documents (below) are unaffected by status.
    semesterDetail = {
      semesterNumber: semester.semesterNumber,
      semesterName: semester.semesterName || "",
      status: semester.status,
      subjects: listSelectableSubjects(structure, semesterNumber),
    };
  }

  let syllabus: PublicSemesterDocument | null = null;
  let programmeDocument: PublicProgrammeDocument | null = null;
  let legacyDocumentWithheld = false;

  // 1. Session-scoped documents hold the exact identity and are preferred.
  try {
    const doc = await ProgrammeSyllabus.findOne({
      programme: programmeCode,
      academicSession,
    });
    programmeDocument = doc ? toSafeProgrammeSyllabus(doc) : null;
  } catch {
    programmeDocument = null;
  }

  if (semesterNumber !== null) {
    try {
      const doc = await Syllabus.findOne({
        programme: programmeCode,
        academicSession,
        semester: semesterNumber,
      });
      syllabus = doc ? toSafeSyllabus(doc) : null;
    } catch {
      syllabus = null;
    }
  }

  // 2. Legacy fallback: session-less documents are attributed only while the
  //    programme has exactly one session; otherwise they are withheld.
  const needsLegacyProgramme = !programmeDocument;
  const needsLegacySemester = semesterNumber !== null && !syllabus;

  if (needsLegacyProgramme || needsLegacySemester) {
    if (await legacyDocumentsAttributable(programmeCode)) {
      if (needsLegacyProgramme) {
        try {
          const doc = await ProgrammeSyllabus.findOne({
            programme: programmeCode,
            academicSession: null,
          });
          programmeDocument = doc ? toSafeProgrammeSyllabus(doc) : null;
        } catch {
          programmeDocument = null;
        }
      }

      if (needsLegacySemester) {
        try {
          const doc = await Syllabus.findOne({
            programme: programmeCode,
            academicSession: null,
            semester: semesterNumber,
          });
          syllabus = doc ? toSafeSyllabus(doc) : null;
        } catch {
          syllabus = null;
        }
      }
    } else {
      legacyDocumentWithheld = await legacyDocumentExists(
        programmeCode,
        semesterNumber
      );
    }
  }

  return ok({
    programme: {
      programmeCode: structure.programmeCode,
      programmeName: structure.programmeName,
      academicSession: structure.academicSession,
      status: structure.status,
      semesterCount: structure.semesters.length,
    },
    semesters,
    semester: semesterDetail,
    syllabus,
    programmeDocument,
    legacyDocumentWithheld,
  });
}
