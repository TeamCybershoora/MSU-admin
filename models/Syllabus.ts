import mongoose, { Schema, type Document } from "mongoose";

/**
 * Syllabus model — one document per programme + semester.
 */

/** A single subject inside a semester's syllabus. */
export interface ISyllabusSubject {
  subjectCode: string;
  subjectName: string;
  syllabusUrl: string | null;
  pdfUrl: string | null;
}

export interface ISyllabus extends Document {
  programme: string;
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

// One syllabus per programme + semester
syllabusSchema.index({ programme: 1, semester: 1 }, { unique: true });

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
