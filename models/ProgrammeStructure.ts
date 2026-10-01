import mongoose, { Schema, type Document } from "mongoose";
import {
  ELECTIVE_SELECTION_RULES,
  MAX_ELECTIVE_GROUP_CODE_LENGTH,
  MAX_SEMESTERS_PER_STRUCTURE,
  MAX_SUBJECTS_PER_SEMESTER,
  STRUCTURE_STATUSES,
  SUBJECT_CATEGORIES,
  SUBJECT_CODE_PATTERN,
  SUBJECT_TYPES,
  effectiveStatus,
  type ElectiveSelectionRule,
  type ProgrammeStructureStatus,
  type SubjectCategory,
  type SubjectType,
} from "@/lib/programme-structure";

/**
 * ProgrammeStructure model — the master academic curriculum definition.
 *
 * WHAT IT IS:
 * One document per programme + academic session, holding the full definition of
 * what is taught:
 *
 *   ProgrammeStructure
 *     ├── programmeCode / programmeName / academicSession / status
 *     └── semesters[]
 *           ├── semesterNumber / semesterName / status
 *           └── subjects[]
 *                 ├── subjectCode / subjectName / credits / subjectType / status
 *                 ├── category            CORE | VALUE_ADDED
 *                 ├── electiveGroup       "" = compulsory, else e.g. "ELECTIVE-I"
 *                 ├── selectionRule       ANY_ONE for elective options, else null
 *                 └── assessment { internalMax, externalMax, practicalMax,
 *                                  totalMax, minimumMarks, internalQualifying }
 *
 * ELECTIVE GROUPS:
 * A curated curriculum contains alternatives, not only compulsory papers: the
 * BCA curriculum has ELECTIVE-I (two options, choose any one) and ELECTIVE-II.
 * The subject list stays FLAT and group membership is a property of each
 * subject, so an option is never mistaken for a compulsory paper: subjects
 * sharing an `electiveGroup` are alternatives of one another, and the group's
 * `selectionRule` says how a student chooses. Result Management needs exactly
 * this to determine which subjects a student may take.
 *
 * SPECIAL ASSESSMENT STRUCTURES (recorded, never invented):
 * `minimumMarks` is the pass/qualifying threshold when the source states one (it
 * is null — not 0 — when it does not), and `internalQualifying` records an
 * internal component that is qualifying rather than numerically marked. Papers
 * with no internal/external split (a project with a flat 100 marks) are recorded
 * entirely in one component rather than being given an invented split.
 *
 * WHY IT IS MASTER DATA:
 * Syllabus will own the DOCUMENTS (subject/semester/programme PDFs) and Result
 * will own STUDENT PERFORMANCE; this collection owns the DEFINITION they both
 * read. Nothing here stores marks obtained by a student, and there are no
 * grade / grade-point / SGPA / CGPA fields — those belong to Result logic in a
 * later phase.
 *
 * STATUS SEMANTICS:
 * Status exists at all three levels (programme structure, semester, subject),
 * and only at those levels. Credits and assessment maxima are properties of a
 * subject, so they are never given their own status: setting a SUBJECT to
 * INACTIVE already makes the subject — together with its credits and marks
 * structure — unavailable for new selection, and the stored values are left
 * untouched for historical reference.
 *
 * Deactivating a parent (structure or semester) does NOT rewrite child records.
 * Availability is derived with effectiveStatus(): a parent INACTIVE makes its
 * children effectively inactive, so reactivating the parent restores exactly the
 * previous state of every child.
 *
 * DELETE POLICY:
 * Nothing in this repository references a ProgrammeStructure yet, so there is no
 * reference check to perform today. Deletion is therefore deliberately
 * conservative — a structure must be INACTIVE and the request must carry an
 * explicit permanent-delete confirmation — and it never cascades into other
 * collections. When Result/Syllabus integration lands, its reference check
 * belongs in the DELETE handler of
 * app/api/admin/academic-structure/route.ts.
 */

/** Maximum-assessment structure of one subject (never a student's marks). */
export interface IProgrammeAssessment {
  internalMax: number;
  externalMax: number;
  practicalMax: number;
  /** Always the sum of the three components above (see lib/programme-structure). */
  totalMax: number;
  /** Pass/qualifying marks, or null when the source states none. */
  minimumMarks: number | null;
  /** True when the internal component is qualifying rather than numerically marked. */
  internalQualifying: boolean;
}

/** A single subject definition inside a semester. */
export interface IProgrammeSubject {
  subjectCode: string;
  subjectName: string;
  credits: number;
  subjectType: SubjectType;
  /** CORE, or VALUE_ADDED for courses the university recognises separately. */
  category: SubjectCategory;
  status: ProgrammeStructureStatus;
  /**
   * Name of the elective group this subject is an OPTION of (e.g. "ELECTIVE-I"),
   * or "" when the subject is compulsory. Subjects sharing a group name are
   * alternatives of one another — they are never all compulsory — and the rule
   * for choosing between them is stored on each member (see selectionRule).
   */
  electiveGroup: string;
  /** ANY_ONE while the subject is an elective option; null when compulsory. */
  selectionRule: ElectiveSelectionRule | null;
  assessment: IProgrammeAssessment;
}

/** A semester of the programme structure. */
export interface IProgrammeSemester {
  /** Numeric identity (1–12); `semesterName` is only a display label. */
  semesterNumber: number;
  semesterName: string;
  status: ProgrammeStructureStatus;
  subjects: IProgrammeSubject[];
}

export interface IProgrammeStructure extends Document {
  /** Programme code (e.g. "BCA") — stored uppercase. */
  programmeCode: string;
  /** Human-readable programme name (e.g. "Bachelor of Computer Applications"). */
  programmeName: string;
  /** Academic session label (e.g. "2025-26"). */
  academicSession: string;
  status: ProgrammeStructureStatus;
  semesters: IProgrammeSemester[];
  createdAt: Date;
  updatedAt: Date;
}

/* ── Validators ────────────────────────────────────────────────── */

const marksValidator = {
  validator: (v: number) => Number.isInteger(v) && v >= 0,
  message: "Maximum marks must be a non-negative whole number.",
};

const creditsValidator = {
  validator: (v: number) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  message: "Credits must be a non-negative number.",
};

const statusValidator = {
  validator: (v: string) => (STRUCTURE_STATUSES as readonly string[]).includes(v),
  message: "Status must be ACTIVE or INACTIVE.",
};

/** null (not stated) or a non-negative whole number. */
const optionalMarksValidator = {
  validator: (v: number | null | undefined) =>
    v === null || v === undefined || (Number.isInteger(v) && v >= 0),
  message: "Minimum marks must be a non-negative whole number.",
};

/* ── Assessment schema ─────────────────────────────────────────── */

const assessmentSchema = new Schema<IProgrammeAssessment>(
  {
    internalMax: {
      type: Number,
      required: [true, "Internal maximum is required."],
      default: 0,
      validate: marksValidator,
    },
    externalMax: {
      type: Number,
      required: [true, "External maximum is required."],
      default: 0,
      validate: marksValidator,
    },
    practicalMax: {
      type: Number,
      required: [true, "Practical maximum is required."],
      default: 0,
      validate: marksValidator,
    },
    // Derived — lib/programme-structure always computes this from the three
    // components so a total can never disagree with its parts. The equality
    // check itself lives on the parent subject's `assessment` path (below),
    // where the whole structure is available even to a hand-written update.
    totalMax: {
      type: Number,
      required: [true, "Total maximum is required."],
      min: [1, "Total maximum must be above 0."],
      validate: marksValidator,
    },
    // Optional: absent means the source states no pass mark. Never defaulted to
    // 0, which would mean "must score nothing" and would be a fabricated value.
    minimumMarks: {
      type: Number,
      default: null,
      validate: optionalMarksValidator,
    },
    // A qualifying internal has no numeric maximum; the flag records that the
    // component EXISTS as a qualification instead of losing it to internalMax 0.
    internalQualifying: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

/* ── Subject schema ────────────────────────────────────────────── */

const subjectSchema = new Schema<IProgrammeSubject>(
  {
    subjectCode: {
      type: String,
      required: [true, "Subject code is required."],
      trim: true,
      uppercase: true,
      validate: {
        validator: (v: string) => SUBJECT_CODE_PATTERN.test(v),
        message:
          "Subject code must be 1-30 characters (letters, digits, spaces, dots, underscores, slashes or hyphens).",
      },
    },
    subjectName: {
      type: String,
      required: [true, "Subject name is required."],
      trim: true,
      maxlength: [200, "Subject name cannot exceed 200 characters."],
    },
    credits: {
      type: Number,
      required: [true, "Credits are required."],
      validate: creditsValidator,
    },
    subjectType: {
      type: String,
      required: [true, "Subject type is required."],
      enum: {
        values: SUBJECT_TYPES as unknown as string[],
        message: "Subject type must be one of: {VALUES}.",
      },
    },
    category: {
      type: String,
      enum: {
        values: SUBJECT_CATEGORIES as unknown as string[],
        message: "Category must be one of: {VALUES}.",
      },
      default: "CORE",
    },
    // Empty string = compulsory. Subjects sharing a group name are the group's
    // OPTIONS; `subjects[]` therefore stays flat, so Phase 1's consumers (and the
    // future Syllabus/Result queries) need no special case for electives.
    electiveGroup: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        MAX_ELECTIVE_GROUP_CODE_LENGTH,
        `Elective group name cannot exceed ${MAX_ELECTIVE_GROUP_CODE_LENGTH} characters.`,
      ],
    },
    // Null passes the enum validator in Mongoose, so "no group" (null) and "any
    // one of the group" (ANY_ONE) are both explicit and neither can be mistaken
    // for the other.
    selectionRule: {
      type: String,
      enum: {
        values: ELECTIVE_SELECTION_RULES as unknown as string[],
        message: "Selection rule must be one of: {VALUES}.",
      },
      default: null,
    },
    status: {
      type: String,
      enum: STRUCTURE_STATUSES as unknown as string[],
      default: "ACTIVE",
      validate: statusValidator,
    },
    // Defence in depth: even a direct database update that bypasses
    // lib/programme-structure cannot store a total that disagrees with its
    // components, or a completely empty (all-zero) marks structure.
    assessment: {
      type: assessmentSchema,
      required: [true, "Assessment structure is required."],
      validate: {
        validator: (v: IProgrammeAssessment) =>
          !!v &&
          v.totalMax === v.internalMax + v.externalMax + v.practicalMax &&
          v.totalMax > 0 &&
          !(v.internalQualifying && v.internalMax > 0),
        message:
          "Total maximum must equal internal + external + practical maximum (and be above 0), and a qualifying internal cannot also carry a numeric maximum.",
      },
    },
  },
  { _id: false }
);

/* ── Semester schema ───────────────────────────────────────────── */

const semesterSchema = new Schema<IProgrammeSemester>(
  {
    semesterNumber: {
      type: Number,
      required: [true, "Semester number is required."],
      min: [1, "Semester number must be at least 1."],
      max: [
        MAX_SEMESTERS_PER_STRUCTURE,
        `Semester number must be at most ${MAX_SEMESTERS_PER_STRUCTURE}.`,
      ],
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: "Semester number must be a whole number.",
      },
    },
    semesterName: {
      type: String,
      default: "",
      trim: true,
      maxlength: [60, "Semester name cannot exceed 60 characters."],
    },
    status: {
      type: String,
      enum: STRUCTURE_STATUSES as unknown as string[],
      default: "ACTIVE",
      validate: statusValidator,
    },
    subjects: {
      type: [subjectSchema],
      default: [],
      validate: {
        validator: (v: IProgrammeSubject[]) => v.length <= MAX_SUBJECTS_PER_SEMESTER,
        message: `A semester cannot have more than ${MAX_SUBJECTS_PER_SEMESTER} subjects.`,
      },
    },
  },
  { _id: false }
);

/* ── Programme structure schema ────────────────────────────────── */

const programmeStructureSchema = new Schema<IProgrammeStructure>(
  {
    programmeCode: {
      type: String,
      required: [true, "Programme code is required."],
      trim: true,
      uppercase: true,
      validate: {
        validator: (v: string) => /^[A-Z][A-Z .&-]{0,19}$/.test(v),
        message:
          "Programme code must be 1-20 characters (letters, spaces, dots, ampersands or hyphens).",
      },
    },
    programmeName: {
      type: String,
      required: [true, "Programme name is required."],
      trim: true,
      maxlength: [150, "Programme name cannot exceed 150 characters."],
    },
    academicSession: {
      type: String,
      required: [true, "Academic session is required."],
      trim: true,
      validate: {
        validator: (v: string) => /^\d{4}-\d{2,4}$/.test(v),
        message: "Academic session must look like 2025-26.",
      },
    },
    status: {
      type: String,
      enum: STRUCTURE_STATUSES as unknown as string[],
      default: "ACTIVE",
      validate: statusValidator,
    },
    semesters: {
      type: [semesterSchema],
      default: [],
      validate: {
        validator: (v: IProgrammeSemester[]) =>
          v.length <= MAX_SEMESTERS_PER_STRUCTURE,
        message: `A programme structure cannot have more than ${MAX_SEMESTERS_PER_STRUCTURE} semesters.`,
      },
    },
  },
  {
    timestamps: true,
  }
);

/**
 * One curriculum per programme + academic session.
 *
 * DECISION — why a compound unique index is safe here:
 * this collection is introduced by this change and no existing code path (or
 * data) references a ProgrammeStructure, so no duplicate documents can already
 * exist to break the index build. `programmeCode` is stored uppercase and
 * trimmed, so the index is effectively case-insensitive without needing a
 * collation, and a duplicate insert is rejected by MongoDB (11000) even under
 * concurrent requests — the API also checks first so the admin gets a readable
 * 409 instead of a raw driver error.
 */
programmeStructureSchema.index(
  { programmeCode: 1, academicSession: 1 },
  { unique: true, name: "idx_programme_structure_identity" }
);
programmeStructureSchema.index({ status: 1 }, { name: "idx_programme_structure_status" });
programmeStructureSchema.index({ programmeCode: 1 }, { name: "idx_programme_structure_programme" });

/* ── Safe mappers ──────────────────────────────────────────────── */

/**
 * Structural type accepted by the safe mappers — works for hydrated documents
 * and for `.lean()` results alike.
 */
export interface ProgrammeStructureLike {
  _id?: unknown;
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: ProgrammeStructureStatus;
  semesters: IProgrammeSemester[];
  createdAt?: Date;
  updatedAt?: Date;
}

type ProgrammeStructureDocLike = ProgrammeStructureLike;

function mapAssessment(assessment: IProgrammeAssessment) {
  return {
    internalMax: assessment.internalMax,
    externalMax: assessment.externalMax,
    practicalMax: assessment.practicalMax,
    totalMax: assessment.totalMax,
    minimumMarks: assessment.minimumMarks ?? null,
    internalQualifying: assessment.internalQualifying ?? false,
  };
}

function mapSubject(subject: IProgrammeSubject) {
  return {
    subjectCode: subject.subjectCode,
    subjectName: subject.subjectName,
    credits: subject.credits,
    subjectType: subject.subjectType,
    category: subject.category ?? "CORE",
    status: subject.status,
    electiveGroup: subject.electiveGroup || "",
    selectionRule: subject.selectionRule ?? null,
    assessment: mapAssessment(subject.assessment),
  };
}

/**
 * Full, safe representation of one programme structure (no _id, no __v).
 * Used by the manage view and by every mutation response, so the client always
 * receives the same shape.
 */
export function toSafeProgrammeStructure(structure: ProgrammeStructureDocLike) {
  return {
    id: String(structure._id ?? ""),
    programmeCode: structure.programmeCode,
    programmeName: structure.programmeName,
    academicSession: structure.academicSession,
    status: structure.status,
    semesterCount: structure.semesters.length,
    subjectCount: structure.semesters.reduce(
      (total, semester) => total + semester.subjects.length,
      0
    ),
    semesters: [...structure.semesters]
      .sort((a, b) => a.semesterNumber - b.semesterNumber)
      .map((semester) => ({
        semesterNumber: semester.semesterNumber,
        semesterName: semester.semesterName || "",
        status: semester.status,
        subjectCount: semester.subjects.length,
        subjects: semester.subjects.map(mapSubject),
      })),
    createdAt: structure.createdAt,
    updatedAt: structure.updatedAt,
  };
}

/**
 * List-row representation: identity, status and counts only. The curriculum
 * itself is never sent to the list page, so a programme with 12 semesters and
 * hundreds of subjects stays a small payload.
 */
export function toSafeProgrammeStructureSummary(structure: ProgrammeStructureDocLike) {
  return {
    id: String(structure._id ?? ""),
    programmeCode: structure.programmeCode,
    programmeName: structure.programmeName,
    academicSession: structure.academicSession,
    status: structure.status,
    semesterCount: structure.semesters.length,
    subjectCount: structure.semesters.reduce(
      (total, semester) => total + semester.subjects.length,
      0
    ),
    createdAt: structure.createdAt,
    updatedAt: structure.updatedAt,
  };
}

/* ── Future integration contract ───────────────────────────────── */

/**
 * The subject list a FUTURE consumer (Syllabus PDF attachment, Result row
 * creation) may select from, for one programme + academic session + semester:
 *
 *   GET /api/admin/academic-structure?programmeCode=…&academicSession=…&semesterNumber=…
 *
 * Only effectively-active subjects are returned: a subject whose own status is
 * INACTIVE, whose SEMESTER is INACTIVE or whose STRUCTURE is INACTIVE is left
 * out — including its credits and assessment structure, because those belong to
 * the subject definition.
 *
 * NOT CONSUMED YET: Phase 1 deliberately implements no Syllabus or Result
 * integration. This helper (and effectiveStatus in lib/programme-structure) is
 * the contract those phases will build on.
 *
 * HISTORICAL RULE this enables: a Result record created later must SNAPSHOT the
 * subject data it sees here (code, name, credits, assessment) instead of reading
 * live curriculum forever, so editing a subject afterwards can never rewrite an
 * already-declared result.
 */
export function listSelectableSubjects(
  structure: Pick<
    IProgrammeStructure,
    "status" | "semesters"
  >,
  semesterNumber: number
) {
  const semester = structure.semesters.find(
    (entry) => entry.semesterNumber === semesterNumber
  );

  if (!semester) return [];

  // The STRUCTURE's status gates every semester; the SEMESTER's status gates its
  // own subjects. Both are combined per subject so a child never needs rewriting
  // when a parent is deactivated.
  const semesterStatus = effectiveStatus(structure.status, semester.status);

  return semester.subjects
    .filter((subject) => effectiveStatus(semesterStatus, subject.status) === "ACTIVE")
    .map(mapSubject);
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const ProgrammeStructure =
  mongoose.models.ProgrammeStructure ||
  mongoose.model<IProgrammeStructure>(
    "ProgrammeStructure",
    programmeStructureSchema
  );

export default ProgrammeStructure;
