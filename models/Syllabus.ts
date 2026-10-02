import mongoose, { Schema, type Document } from "mongoose";
import { ACADEMIC_SESSION_PATTERN } from "@/lib/programme-structure";

/**
 * Syllabus model — the DOCUMENT layer for one academic identity.
 *
 * OWNERSHIP (Phase 2A): ProgrammeStructure is the single source of truth for
 * academic metadata. This collection stores only syllabus DOCUMENTS and their
 * associations; it never defines curriculum.
 *
 * Identity is `programme + academicSession + semester`. `programme` and
 * `academicSession` are NOT free text chosen here — they are validated against
 * an existing ProgrammeStructure by the admin API, and the subject list is
 * limited to subjects that structure actually defines (the stored `subjectName`
 * is a denormalized display snapshot, always re-derived from the structure on
 * write, never an independent curriculum definition).
 *
 * LEGACY RECORDS: documents written before the integration carry no
 * `academicSession` (stored as null). They are preserved exactly as they are and
 * are never given a guessed session — a session-less record can only be
 * removed, never silently attributed.
 */

/** A single subject inside a semester's syllabus. */
export interface ISyllabusSubject {
  subjectCode: string;
  subjectName: string;
  syllabusUrl: string | null;
  pdfUrl: string | null;
}

export interface ISyllabus extends Document {
  /** Programme code (e.g. "BCA") — stored uppercase; owned by ProgrammeStructure. */
  programme: string;
  /**
   * Academic session (e.g. "2023-24") — the second half of the academic
   * identity. Null only on legacy documents created before the integration.
   */
  academicSession: string | null;
  /** Numeric semester identity (1–12); `programme + academicSession + semester` is the key. */
  semester: number;
  subjects: ISyllabusSubject[];
  /** Public URL of the syllabus PDF for this programme + semester (null = none). */
  pdfUrl: string | null;
  /** Original display name of the attached PDF (null = none). */
  pdfName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Structural type accepted by toSafeSyllabus (works for hydrated and lean docs). */
type SyllabusLike = Pick<
  ISyllabus,
  "programme" | "semester" | "subjects" | "pdfUrl" | "pdfName"
>;

/** Academic session is optional (legacy) but must look like 2025-26 when present. */
const academicSessionValidator = {
  validator: (v: string | null | undefined) =>
    v === null || v === undefined || v === "" || ACADEMIC_SESSION_PATTERN.test(v),
  message: "Academic session must look like 2025-26.",
};

/** URL is optional; when present it must be a well-formed http(s) link. */
const urlValidator = {
  validator: (v: string | null | undefined) =>
    v === null || v === undefined || v === "" || /^https?:\/\/\S+$/i.test(v),
  message: "URL must be a valid http(s) link.",
};

const subjectSchema = new Schema<ISyllabusSubject>(
  {
    subjectCode: {
      type: String,
      required: [true, "Subject code is required"],
      trim: true,
    },
    subjectName: {
      type: String,
      required: [true, "Subject name is required"],
      trim: true,
    },
    syllabusUrl: {
      type: String,
      default: null,
      validate: urlValidator,
    },
    pdfUrl: {
      type: String,
      default: null,
      validate: urlValidator,
    },
  },
  { _id: false }
);

const syllabusSchema = new Schema<ISyllabus>(
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
    // New documents always carry the session of the ProgrammeStructure they were
    // validated against; the API (not the schema) is what requires it, so an
    // existing legacy record stays loadable and saveable.
    academicSession: {
      type: String,
      default: null,
      trim: true,
      uppercase: false,
      validate: academicSessionValidator,
    },
    semester: {
      type: Number,
      required: [true, "Semester is required"],
      min: [1, "Semester must be at least 1"],
      max: [12, "Semester must be at most 12"],
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: "Semester must be a whole number.",
      },
    },
    subjects: {
      type: [subjectSchema],
      default: [],
      validate: {
        validator: (v: ISyllabusSubject[]) => v.length <= 30,
        message: "A semester cannot have more than 30 subjects.",
      },
    },
    // PDF attached to the whole programme + semester. The value is always a
    // URL issued by POST /api/admin/syllabus/upload (a GridFS-backed reference),
    // never a raw filesystem path.
    pdfUrl: {
      type: String,
      default: null,
      validate: urlValidator,
    },
    // Display-only label; reads always go through pdfUrl's id, so this can
    // never be used to reach a file on disk.
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
 * One syllabus document per academic identity: programme + academicSession +
 * semester.
 *
 * The session is part of the key so BCA / 2023-24 / Semester 1 and
 * BCA / 2025-26 / Semester 1 are different documents. Legacy session-less
 * records index with a null session and are never merged into a session.
 *
 * MIGRATION NOTE: this replaces the original `{ programme, semester }` unique
 * index. An existing database still carries that older index, which must be
 * dropped once by an operator (see the Phase 2A report) — this code neither
 * drops nor rewrites any index or record automatically.
 */
syllabusSchema.index(
  { programme: 1, academicSession: 1, semester: 1 },
  { unique: true, name: "idx_syllabus_identity" }
);
// Legacy lookups (session-less records) stay cheap without being unique.
syllabusSchema.index({ programme: 1, semester: 1 }, { name: "idx_syllabus_legacy_identity" });

/**
 * Return clean, public syllabus data (no _id, no __v, no timestamps).
 */
export function toSafeSyllabus(syllabus: SyllabusLike) {
  return {
    programme: syllabus.programme,
    semester: syllabus.semester,
    pdfUrl: syllabus.pdfUrl ?? null,
    pdfName: syllabus.pdfName ?? null,
    subjects: syllabus.subjects.map((subject) => ({
      subjectCode: subject.subjectCode,
      subjectName: subject.subjectName,
      syllabusUrl: subject.syllabusUrl ?? null,
      pdfUrl: subject.pdfUrl ?? null,
    })),
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Syllabus =
  mongoose.models.Syllabus ||
  mongoose.model<ISyllabus>("Syllabus", syllabusSchema);

export default Syllabus;
