import mongoose, { Schema, type Document } from "mongoose";
import {
  SUBJECT_CODE_PATTERN,
  SUBJECT_TYPES,
  type SubjectType,
} from "@/lib/programme-structure";

/**
 * Result model — stores semester-wise examination results for students.
 *
 * One document per student + semester result.
 *
 * PHASE 3A — CURRICULUM SNAPSHOT:
 * Subjects are resolved from the ProgrammeStructure curriculum when a Result is
 * created, and the academic metadata used at that moment is SNAPSHOTTED here
 * (name, credits, subjectType, assessment maximum). ProgrammeStructure is the
 * source of truth, but a declared Result must never change later because the
 * curriculum was edited — so no historical Result reads ProgrammeStructure.
 *
 * The snapshot is intentionally narrow: `curriculum` records the identity that
 * was used (programmeCode + semesterNumber; the session is already stored on
 * `student.academicSession`), and each subject carries its own snapshot fields.
 * It is OPTIONAL, so Results created before this integration remain readable
 * and are never migrated or rewritten.
 *
 * PHASE 3B — ACADEMIC CALCULATIONS:
 * For curriculum-linked Results the server (lib/result-grading.ts) recalculates
 * the authoritative figures on every write: subject total, subject percentage,
 * grade point (from the percentage, never from the letter grade), result
 * percentage and SGPA. The manually entered `grade` is passed through as-is.
 * `sgpa` is therefore stored for new Results; `cgpa` stays null until reliable
 * per-student semester history exists (no Student ↔ Result integration yet).
 * Legacy Results (no curriculum) keep their originally stored values and are
 * never migrated.
 *
 * PHASE 3C — AUTOMATIC SGPA + CGPA:
 * Every curriculum-linked write recalculates SGPA here and, from the student's
 * other curriculum-linked semester Results, the credit-weighted cumulative
 * CGPA. The identity used to collect those semesters is the persisted one
 * (enrollmentNumber + programmeCode + academicSession), and the authoritative
 * values are stored on each semester's Result — the client can never supply or
 * override SGPA/CGPA. Legacy Results (no curriculum) are never migrated or
 * forced into the cumulative calculation.
 */

/** A single subject within a semester result. */
export interface IResultSubject {
  subjectCode: string;
  subjectName: string;
  internalMarks: number;
  externalMarks: number;
  totalMarks: number;
  maxMarks: number;
  grade: string;
  gradePoint: number;
  credits: number;
  /**
   * Snapshot of the subject's type in ProgrammeStructure (THEORY / PRACTICAL /
   * THEORY_PRACTICAL). Null on Results created before the integration.
   */
  subjectType: SubjectType | null;
  isBacklog: boolean;
  /** True when the candidate was absent for this subject (stored as grade AB, 0 points). */
  isAbsent: boolean;
}

/**
 * The curriculum identity a Result was created against.
 *
 * Only the values that were never stored before live here: the programme CODE
 * (student.course is the display name) and the numeric semester (student.semester
 * is a display label). `student.academicSession` already holds the session.
 */
export interface IResultCurriculum {
  programmeCode: string;
  semesterNumber: number;
}

/** Student identity and programme info embedded in the result. */
export interface IResultStudent {
  name: string;
  rollNumber: string;
  enrollmentNumber: string;
  course: string;
  semester: string;
  academicSession: string;
  collegeName: string;
  /**
   * Optional identity fields, snapshotted with the Result (the printed
   * Statement of Marks reads them from here). Empty string when not recorded —
   * the document renders an em dash. They are never derived, only admin-entered.
   */
  fatherName: string;
  motherName: string;
  gender: string;
}

/** Full result document */
export interface IResult extends Document {
  student: IResultStudent;
  /** Curriculum identity snapshot; null on Results created before Phase 3A. */
  curriculum: IResultCurriculum | null;
  subjects: IResultSubject[];
  totalMarks: number;
  maxTotalMarks: number;
  percentage: number;
  /** Credit-weighted SGPA, 2 dp; null on Results written before Phase 3B. */
  sgpa: number | null;
  /**
   * Credit-weighted cumulative SGPA through this semester, stored at 2 dp
   * (e.g. "8.54"); null on Results written before Phase 3C and on legacy
   * Results. Recomputed on every curriculum-linked write so it never goes
   * stale when an earlier semester changes.
   */
  cgpa: string | null;
  /** Equivalent percentage (CGPA x 9.5), 2 dp; null until a CGPA exists. */
  equivalentPercentage: number | null;
  /**
   * Semester result status, derived server-side from the subjects (see
   * lib/result-grading.ts): FAIL when a subject is Fail/Absent, else PASS.
   * There is deliberately no "Compartment" SEMESTER status — a compartment
   * subject is reported on its own row and never fails the semester.
   */
  resultStatus: "PASS" | "FAIL";
  remarks: string;
  declaredDate: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Structural type for the safe mapper (works for hydrated and lean docs). */
type ResultLike = Pick<
  IResult,
  | "student"
  | "curriculum"
  | "subjects"
  | "totalMarks"
  | "maxTotalMarks"
  | "percentage"
  | "sgpa"
  | "cgpa"
  | "equivalentPercentage"
  | "resultStatus"
  | "remarks"
  | "declaredDate"
>;

/* ── Validators ────────────────────────────────────────────────── */

const nonNegativeNumber = {
  validator: (v: number) => typeof v === "number" && v >= 0,
  message: "Value must be a non-negative number.",
};

const positiveNumber = {
  validator: (v: number) => typeof v === "number" && v > 0,
  message: "Value must be a positive number.",
};

const percentageRange = {
  validator: (v: number) => typeof v === "number" && v >= 0 && v <= 100,
  message: "Percentage must be between 0 and 100.",
};

const validGradePoint = {
  validator: (v: number) => typeof v === "number" && v >= 0,
  message: "Grade point must be a non-negative number.",
};

const validCredits = {
  // Non-negative, matching ProgrammeStructure.parseCredits: 0 = qualifying/
  // non-credit course, decimals allowed so curriculum credits always fit.
  validator: (v: number) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  message: "Credits must be a non-negative number.",
};

// Aligned with ProgrammeStructure's subject-code rule: curriculum codes the
// structure accepts must be storable on a Result (alphanumeric codes are a
// strict subset, so every existing Result stays valid).
const subjectCodePattern = SUBJECT_CODE_PATTERN;
const subjectTypeValues = SUBJECT_TYPES as unknown as string[];
const subjectNameRequired = {
  validator: (v: string) => typeof v === "string" && v.trim().length > 0,
  message: "Subject name is required.",
};

const gradeLetterPattern = /^[A-Za-z+#-]+$/;

/* ── Subject Schema ─────────────────────────────────────────────── */

const resultSubjectSchema = new Schema<IResultSubject>(
  {
    subjectCode: {
      type: String,
      required: [true, "Subject code is required"],
      trim: true,
      validate: {
        validator: (v: string) => subjectCodePattern.test(v),
        message: "Subject code must be alphanumeric.",
      },
    },
    subjectName: {
      type: String,
      required: [true, "Subject name is required"],
      trim: true,
      validate: subjectNameRequired,
    },
    internalMarks: {
      type: Number,
      required: [true, "Internal marks are required"],
      validate: nonNegativeNumber,
    },
    externalMarks: {
      type: Number,
      required: [true, "External marks are required"],
      validate: nonNegativeNumber,
    },
    totalMarks: {
      type: Number,
      required: [true, "Total marks are required"],
      validate: nonNegativeNumber,
    },
    maxMarks: {
      type: Number,
      required: [true, "Max marks are required"],
      validate: positiveNumber,
    },
    grade: {
      type: String,
      required: [true, "Grade is required"],
      trim: true,
      validate: {
        validator: (v: string) => gradeLetterPattern.test(v),
        message: "Grade must be a valid letter grade.",
      },
    },
    gradePoint: {
      type: Number,
      required: [true, "Grade point is required"],
      validate: validGradePoint,
    },
    credits: {
      type: Number,
      required: [true, "Credits are required"],
      validate: validCredits,
    },
    // Optional on purpose: Results written before Phase 3A carry no type.
    subjectType: {
      type: String,
      enum: {
        values: subjectTypeValues,
        message: "Subject type must be one of: {VALUES}.",
      },
      default: null,
    },
    isBacklog: {
      type: Boolean,
      required: [true, "isBacklog is required"],
      default: false,
    },
    // True when the candidate was absent for this subject; grade is AB and
    // grade point 0. Default false keeps existing Results valid.
    isAbsent: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

/* ── Curriculum snapshot schema ─────────────────────────────────── */

const resultCurriculumSchema = new Schema<IResultCurriculum>(
  {
    programmeCode: {
      type: String,
      required: [true, "Programme code is required"],
      trim: true,
      uppercase: true,
    },
    semesterNumber: {
      type: Number,
      required: [true, "Semester number is required"],
      min: [1, "Semester number must be at least 1"],
      max: [12, "Semester number must be at most 12"],
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: "Semester number must be a whole number.",
      },
    },
  },
  { _id: false }
);

/* ── Student Schema (embedded) ───────────────────────────────────── */

const resultStudentSchema = new Schema<IResultStudent>(
  {
    name: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },
    rollNumber: {
      type: String,
      required: [true, "Roll number is required"],
      trim: true,
      uppercase: true,
    },
    enrollmentNumber: {
      type: String,
      required: [true, "Enrollment number is required"],
      trim: true,
      uppercase: true,
    },
    course: {
      type: String,
      required: [true, "Course is required"],
      trim: true,
    },
    semester: {
      type: String,
      required: [true, "Semester is required"],
      trim: true,
    },
    academicSession: {
      type: String,
      required: [true, "Academic session is required"],
      trim: true,
    },
    collegeName: {
      type: String,
      required: [true, "College name is required"],
      trim: true,
    },
    // Optional identity fields. Stored on the Result snapshot so the statement
    // always prints what was recorded, independent of any curriculum edit.
    fatherName: {
      type: String,
      default: "",
      trim: true,
    },
    motherName: {
      type: String,
      default: "",
      trim: true,
    },
    gender: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false }
);

/* ── Result Schema ───────────────────────────────────────────────── */

const resultSchema = new Schema<IResult>(
  {
    student: {
      type: resultStudentSchema,
      required: [true, "Student info is required"],
    },
    // Null = a Result created before the integration (never back-filled).
    curriculum: {
      type: resultCurriculumSchema,
      default: null,
    },
    subjects: {
      type: [resultSubjectSchema],
      default: [],
      validate: {
        validator: (v: IResultSubject[]) => v.length > 0,
        message: "At least one subject is required.",
      },
    },
    totalMarks: {
      type: Number,
      required: [true, "Total marks are required"],
      validate: nonNegativeNumber,
    },
    maxTotalMarks: {
      type: Number,
      required: [true, "Max total marks are required"],
      validate: positiveNumber,
    },
    percentage: {
      type: Number,
      required: [true, "Percentage is required"],
      validate: percentageRange,
    },
    // Calculated server-side from credits × grade points (lib/result-grading.ts).
    // Optional: legacy Results predate the field and are never migrated.
    sgpa: {
      type: Number,
      default: null,
      validate: {
        validator: (v: number | null) =>
          v === null || (typeof v === "number" && v >= 0 && v <= 10),
        message: "SGPA must be between 0 and 10.",
      },
    },
    // Phase 3C: credit-weighted cumulative CGPA through this semester, stored
    // as a 2 dp string. Null while no included semester exists / on legacy
    // Results; recomputed server-side on every curriculum-linked write.
    cgpa: {
      type: String,
      default: null,
      trim: true,
    },
    // Equivalent percentage (CGPA x 9.5), 2 dp; null until a CGPA exists.
    equivalentPercentage: {
      type: Number,
      default: null,
    },
    resultStatus: {
      type: String,
      required: [true, "Result status is required"],
      enum: {
        values: ["PASS", "FAIL"],
        message: "Result status must be one of: PASS, FAIL.",
      },
    },
    remarks: {
      type: String,
      default: "",
      trim: true,
    },
    declaredDate: {
      type: String,
      required: [true, "Declared date is required"],
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

resultSchema.index(
  { "student.rollNumber": 1, "student.enrollmentNumber": 1 },
  { name: "idx_result_roll_enrollment" }
);

resultSchema.index({ "student.rollNumber": 1 }, { name: "idx_result_roll" });
resultSchema.index(
  { "student.enrollmentNumber": 1 },
  { name: "idx_result_enrollment" }
);

/**
 * Return clean, public result data (no _id, no __v, no timestamps).
 */
export function toSafeResult(result: ResultLike) {
  return {
    student: {
      name: result.student.name,
      rollNumber: result.student.rollNumber,
      enrollmentNumber: result.student.enrollmentNumber,
      course: result.student.course,
      semester: result.student.semester,
      academicSession: result.student.academicSession,
      collegeName: result.student.collegeName,
      fatherName: result.student.fatherName ?? "",
      motherName: result.student.motherName ?? "",
      gender: result.student.gender ?? "",
    },
    curriculum: result.curriculum
      ? {
          programmeCode: result.curriculum.programmeCode,
          semesterNumber: result.curriculum.semesterNumber,
        }
      : null,
    subjects: result.subjects.map((subject) => ({
      subjectCode: subject.subjectCode,
      subjectName: subject.subjectName,
      internalMarks: subject.internalMarks,
      externalMarks: subject.externalMarks,
      totalMarks: subject.totalMarks,
      maxMarks: subject.maxMarks,
      grade: subject.grade,
      gradePoint: subject.gradePoint,
      credits: subject.credits,
      subjectType: subject.subjectType ?? null,
      isBacklog: subject.isBacklog,
      isAbsent: subject.isAbsent === true,
    })),
    totalMarks: result.totalMarks,
    maxTotalMarks: result.maxTotalMarks,
    percentage: result.percentage,
    sgpa: result.sgpa ?? null,
    cgpa: result.cgpa ?? null,
    equivalentPercentage: result.equivalentPercentage ?? null,
    resultStatus: result.resultStatus,
    remarks: result.remarks,
    declaredDate: result.declaredDate,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Result =
  mongoose.models.Result || mongoose.model<IResult>("Result", resultSchema);

export default Result;
