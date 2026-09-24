import mongoose, { Schema, type Document } from "mongoose";

/**
 * Programme-level official syllabus document — one per programme.
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

// Exactly one official programme syllabus document per programme.
programmeSyllabusSchema.index({ programme: 1 }, { unique: true });

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
