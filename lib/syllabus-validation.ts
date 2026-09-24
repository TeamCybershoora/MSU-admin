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

/** Normalised subject shape stored inside a semester's syllabus. */
export interface SyllabusSubjectInput {
  subjectCode: string;
  subjectName: string;
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
 * Validate + normalise a list of subjects.
 *
 * Empty lists are rejected (a semester upsert must carry at least one subject);
 * codes/names are trimmed and required, and the optional URLs must be valid
 * http(s) links. Extra/unknown fields are dropped.
 */
export function validateSubjects(
  value: unknown
): ValidationResult<SyllabusSubjectInput[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: "At least one subject is required." };
  }

  const subjects: SyllabusSubjectInput[] = [];

  for (let i = 0; i < value.length; i++) {
    const raw = value[i] as Record<string, unknown> | null;

    if (!raw || typeof raw !== "object") {
      return {
        ok: false,
        message: `Subject ${i + 1}: subjectCode and subjectName are required.`,
      };
    }

    const subjectCode =
      typeof raw.subjectCode === "string" ? raw.subjectCode.trim() : "";
    const subjectName =
      typeof raw.subjectName === "string" ? raw.subjectName.trim() : "";

    if (!subjectCode || !subjectName) {
      return {
        ok: false,
        message: `Subject ${i + 1}: subjectCode and subjectName are required.`,
      };
    }

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

    subjects.push({ subjectCode, subjectName, ...urls });
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
