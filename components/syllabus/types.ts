/**
 * Shared client-side types for the syllabus management UI.
 *
 * These mirror the shapes returned by the admin API and are used by every
 * syllabus component, so a semester card renders identically for BCA, B.Tech
 * or any other programme — nothing is programme-specific.
 *
 * `academicSession` is the second half of the academic identity (programme +
 * academicSession + semester) and is null only on legacy documents created
 * before the Academic Structure integration.
 */

/** A single subject inside a semester's syllabus. */
export interface SyllabusSubject {
  subjectCode: string;
  subjectName: string;
  syllabusUrl: string | null;
  pdfUrl: string | null;
}

/** One programme + academic session + semester structured syllabus document. */
export interface SyllabusRecord {
  id: string;
  programme: string;
  /** Null only on legacy session-less documents. */
  academicSession: string | null;
  semester: number;
  subjects: SyllabusSubject[];
  subjectCount: number;
  pdfUrl: string | null;
  pdfName: string | null;
  createdAt: string;
}

/** The one official programme-level syllabus PDF document for a programme + session. */
export interface ProgrammeSyllabusRecord {
  id: string;
  programme: string;
  /** Null only on legacy session-less documents. */
  academicSession: string | null;
  pdfUrl: string | null;
  pdfName: string | null;
  createdAt: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SyllabusFilters {
  programmes: string[];
}

/** A blank subject row, used as the starting point for new subjects. */
export function emptySubject(): SyllabusSubject {
  return { subjectCode: "", subjectName: "", syllabusUrl: null, pdfUrl: null };
}

/**
 * Display label for a syllabus academic identity.
 *
 * A session-less (legacy) record is labelled as such and is never shown under a
 * guessed session.
 */
export function identityLabel(
  programme: string,
  academicSession: string | null
): string {
  return academicSession
    ? `${programme} — ${academicSession}`
    : `${programme} · legacy (no session)`;
}
