/**
 * Shared validation logic for the syllabus admin API.
 *
 * Kept as plain functions (no route, no model, no database access) so the exact
 * same rules are applied wherever syllabus data enters the system — currently
 * POST (full semester upsert), PATCH (single subject add/update) and the
 * semester-PDF attachment handling. Nothing here is specific to a programme,
 * semester or subject name.
 */

import { parseSyllabusPdfId } from "@/lib/pdf-storage";
import { safePdfFilename } from "@/lib/validation";

/**
 * Normalised subject reference as submitted by the admin UI.
 *
 * It carries only what Syllabus Management OWNS — the subject CODE (the
 * academic identity) and the document links. `subjectName` is deliberately not
 * part of this shape: the name is authoritative in ProgrammeStructure and is
 * filled in by the route from the resolved structure.
 */
export interface SyllabusSubjectRef {
  subjectCode: string;
  syllabusUrl: string | null;
  pdfUrl: string | null;
}

/** Discriminated result used by every validator below. */
export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

/** Only well-formed http(s) links are accepted for the optional subject URLs. */
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

/**
 * Validate + normalise a list of subject REFERENCES.
 *
 * A reference carries the subject code plus the optional document links; the
 * subject name and all academic metadata come from ProgrammeStructure and are
 * never read from the request. The list may be empty (a semester may hold only
 * a semester-level PDF) and duplicate codes are rejected so one subject is
 * never attached twice within the same semester document.
 */
export function validateSubjectRefs(
  value: unknown
): ValidationResult<SyllabusSubjectRef[]> {
  if (!Array.isArray(value)) {
    return { ok: false, message: "Subjects must be a list." };
  }

  const subjects: SyllabusSubjectRef[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < value.length; i++) {
    const raw = value[i] as Record<string, unknown> | null;

    if (!raw || typeof raw !== "object") {
      return { ok: false, message: `Subject ${i + 1}: subjectCode is required.` };
    }

    const subjectCode =
      typeof raw.subjectCode === "string" ? raw.subjectCode.trim() : "";

    if (!subjectCode) {
      return { ok: false, message: `Subject ${i + 1}: subjectCode is required.` };
    }

    const key = subjectCode.toUpperCase();
    if (seen.has(key)) {
      return {
        ok: false,
        message: `Subject ${subjectCode} appears more than once in this semester.`,
      };
    }
    seen.add(key);

    const urls: { syllabusUrl: string | null; pdfUrl: string | null } = {
      syllabusUrl: null,
      pdfUrl: null,
    };

    for (const field of ["syllabusUrl", "pdfUrl"] as const) {
      const rawUrl = raw[field];
      if (rawUrl === undefined || rawUrl === null || rawUrl === "") continue;

      if (typeof rawUrl !== "string" || !HTTP_URL_PATTERN.test(rawUrl.trim())) {
        return {
          ok: false,
          message: `Subject ${i + 1}: ${field} must be a valid http(s) link.`,
        };
      }

      urls[field] = rawUrl.trim();
    }

    subjects.push({ subjectCode, ...urls });
  }

  return { ok: true, data: subjects };
}

/**
 * Resolve the optional semester-level PDF attachment from a request body.
 *
 *   undefined → the attachment was not mentioned, leave it untouched
 *   null / "" → explicitly clear it
 *   string    → must be a reference this server issued (parseSyllabusPdfId)
 *
 * Only upload references are accepted, so an arbitrary URL or filesystem path
 * can never be stored on a syllabus record.
 */
export function parseAttachment(
  pdfUrl: unknown,
  pdfName: unknown
): ValidationResult<
  { pdfUrl: string | null; pdfName: string | null } | undefined
> {
  if (pdfUrl === undefined) return { ok: true, data: undefined };

  if (pdfUrl === null || pdfUrl === "") {
    return { ok: true, data: { pdfUrl: null, pdfName: null } };
  }

  if (typeof pdfUrl !== "string" || !parseSyllabusPdfId(pdfUrl)) {
    return { ok: false, message: "Invalid PDF reference." };
  }

  return {
    ok: true,
    data: {
      pdfUrl,
      pdfName:
        typeof pdfName === "string" && pdfName.trim()
          ? safePdfFilename(pdfName)
          : null,
    },
  };
}
