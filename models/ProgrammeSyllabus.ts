import mongoose, { Schema, type Document } from "mongoose";
import { ACADEMIC_SESSION_PATTERN } from "@/lib/programme-structure";

/**
 * Programme-level official syllabus document — one per programme + session.
 *
 * Identity is `programme + academicSession`, validated against an existing
 * ProgrammeStructure by the admin API. ProgrammeStructure owns the programme;
 * this collection only owns the DOCUMENT (the PDF association).
 *
 * Legacy documents written before the integration carry no `academicSession`
 * (null) and are preserved as-is; they can be removed but are never given a
 * guessed session.
 *
 * WHY A SEPARATE COLLECTION:
 * A university may publish ONE official syllabus PDF for an entire programme
 * (e.g. "BCA Complete Syllabus 2026-27.pdf") instead of a PDF per semester or
 * subject. The existing Syllabus model is keyed on programme + semester, so it
 * cannot represent a programme-wide document that must exist even when there
 * are no semester/subject records at all.
 *
 * This collection is additive: existing Syllabus documents are untouched and
 * continue to work exactly as before. A programme may have:
 *   - a programme PDF and no structured records, or
 *   - structured records and no programme PDF, or
 *   - both.
 *
 * The stored `pdfUrl` is always a reference issued by
 * POST /api/admin/syllabus/upload (a GridFS-backed URL), never a raw path.
 */

export interface IProgrammeSyllabus extends Document {
  /** Programme code (e.g. "BCA") — stored uppercase */
  programme: string;
  /** Academic session (e.g. "2023-24"); null only on legacy documents. */
  academicSession: string | null;
  /** Public URL of the official programme syllabus PDF (null = none). */
  pdfUrl: string | null;
  /** Original display name of the attached PDF (null = none). */
  pdfName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Structural type accepted by toSafeProgrammeSyllabus. */
type ProgrammeSyllabusLike = Pick<
  IProgrammeSyllabus,
  "programme" | "pdfUrl" | "pdfName"
>;

/** URL is optional; when present it must be a well-formed http(s) link. */
const urlValidator = {
  validator: (v: string | null | undefined) =>
    v === null || v === undefined || v === "" || /^https?:\/\/\S+$/i.test(v),
  message: "URL must be a valid http(s) link.",
};

/** Academic session is optional (legacy) but must look like 2025-26 when present. */
const academicSessionValidator = {
  validator: (v: string | null | undefined) =>
    v === null || v === undefined || v === "" || ACADEMIC_SESSION_PATTERN.test(v),
  message: "Academic session must look like 2025-26.",
};

const programmeSyllabusSchema = new Schema<IProgrammeSyllabus>(
  {
    programme: {
      type: String,
      required: [true, "Programme is required"],
      trim: true,
      uppercase: true,
      validate: {
        validator: (v: string) => /^[A-Z][A-Z .&-]{0,19}$/.test(v),
        message:
          "Programme must be 1-20 characters (letters, spaces, dots, ampersands or hyphens).",
      },
    },
    // Null = a legacy document that predates the Academic Structure integration.
    academicSession: {
      type: String,
      default: null,
      trim: true,
      validate: academicSessionValidator,
    },
    // Value is always a URL issued by POST /api/admin/syllabus/upload.
    pdfUrl: {
      type: String,
      default: null,
      validate: urlValidator,
    },
    // Display-only label; reads always go through pdfUrl's id.
    pdfName: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * One official programme syllabus document per programme + academic session.
 *
 * MIGRATION NOTE: this replaces the original `{ programme }` unique index. An
 * existing database still carries that older index, which must be dropped once
 * by an operator (see the Phase 2A report); no index or record is dropped or
 * rewritten automatically by this code.
 */
programmeSyllabusSchema.index(
  { programme: 1, academicSession: 1 },
  { unique: true, name: "idx_programme_syllabus_identity" }
);
// Legacy (session-less) programme document lookup stays cheap and non-unique.
programmeSyllabusSchema.index(
  { programme: 1 },
  { name: "idx_programme_syllabus_legacy_identity" }
);

/**
 * Return clean, public programme syllabus data (no _id, no __v, no timestamps).
 */
export function toSafeProgrammeSyllabus(doc: ProgrammeSyllabusLike) {
  return {
    programme: doc.programme,
    pdfUrl: doc.pdfUrl ?? null,
    pdfName: doc.pdfName ?? null,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const ProgrammeSyllabus =
  mongoose.models.ProgrammeSyllabus ||
  mongoose.model<IProgrammeSyllabus>(
    "ProgrammeSyllabus",
    programmeSyllabusSchema
  );

export default ProgrammeSyllabus;
