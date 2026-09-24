import mongoose, { Schema, type Document } from "mongoose";

/**
 * Result model — stores semester-wise examination results for students.
 *
 * One document per student + semester result.
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
  isBacklog: boolean;
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
}

/** Full result document */
export interface IResult extends Document {
  student: IResultStudent;
  subjects: IResultSubject[];
  totalMarks: number;
  maxTotalMarks: number;
  percentage: number;
  cgpa: string;
  resultStatus: "PASS" | "FAIL" | "COMPARTMENT";
  remarks: string;
  declaredDate: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Structural type for the safe mapper (works for hydrated and lean docs). */
type ResultLike = Pick<
  IResult,
  | "student"
  | "subjects"
  | "totalMarks"
  | "maxTotalMarks"
  | "percentage"
  | "cgpa"
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
  validator: (v: number) =>
    typeof v === "number" && Number.isInteger(v) && v > 0,
  message: "Credits must be a positive integer.",
};

const subjectCodePattern = /^[A-Za-z0-9]+$/;
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
    isBacklog: {
      type: Boolean,
      required: [true, "isBacklog is required"],
      default: false,
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
    cgpa: {
      type: String,
      required: [true, "CGPA is required"],
      trim: true,
    },
    resultStatus: {
      type: String,
      required: [true, "Result status is required"],
      enum: {
        values: ["PASS", "FAIL", "COMPARTMENT"],
        message: "Result status must be one of: PASS, FAIL, COMPARTMENT.",
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
    },
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
      isBacklog: subject.isBacklog,
    })),
    totalMarks: result.totalMarks,
    maxTotalMarks: result.maxTotalMarks,
    percentage: result.percentage,
    cgpa: result.cgpa,
    resultStatus: result.resultStatus,
    remarks: result.remarks,
    declaredDate: result.declaredDate,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Result =
  mongoose.models.Result || mongoose.model<IResult>("Result", resultSchema);

export default Result;
