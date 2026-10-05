/**
 * Types for the official MSU Statement of Marks (Semester Result) document.
 *
 * These mirror the shape returned by `toSafeResult()` in models/Result.ts and
 * keep the document component independent of the API/route layer.
 *
 * Used by:
 * - components/results/result-document.tsx
 * - components/results/result-marks-table.tsx
 * - app/admin/results/page.tsx (View Result modal)
 */

/**
 * The only selectable gender values. Single source of truth shared by the Add /
 * Edit forms (radio group) and the tests — gender is never free text, and the
 * list is deliberately closed so no multiple representations can appear.
 */
export const GENDER_OPTIONS = ["Male", "Female", "Other"] as const;
export type Gender = (typeof GENDER_OPTIONS)[number];

/** True when a value is one of the allowed gender options ("" allowed = not set). */
export function isGender(value: unknown): value is Gender | "" {
  return value === "" || GENDER_OPTIONS.includes(value as Gender);
}

/** Student identity block printed on the statement. */
export interface StatementStudent {
  name: string;
  rollNumber: string;
  enrollmentNumber: string;
  course: string;
  semester: string;
  academicSession: string;
  collegeName: string;
  /*
   * Optional identity fields.
   *
   * models/Result.ts does not store these yet, so the document renders an em
   * dash when they are absent. They are typed here (rather than invented in
   * the UI) so the statement can print them the moment the model is extended.
   */
  fatherName?: string;
  motherName?: string;
  gender?: string;
}

/** One subject row on the statement. */
export interface StatementSubject {
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
   * Curriculum subject type (THEORY / PRACTICAL / THEORY_PRACTICAL) snapshotted
   * on the Result. Drives the per-subject passing threshold (Practical 40%,
   * Theory 36%). Null/absent on legacy results, which are treated as Theory.
   */
  subjectType?: string | null;
  isBacklog: boolean;
  /** True when the candidate was absent: the statement prints an em dash for marks. */
  isAbsent?: boolean;
}

/**
 * A previous semester's headline figures.
 *
 * Deliberately headline-only: the Semester Result never prints another
 * semester's subject-wise marks (those belong to that semester's statement).
 */
export interface PreviousSemester {
  semester: string;
  credits: number | string;
  sgpa: number | string;
  cgpa?: number | string;
  status: string;
}

/** One row of the grade-scale legend. */
export interface GradeScaleRow {
  grade: string;
  gradePoint: number | string;
  range: string;
}

/** Everything the Statement of Marks needs to render. */
export interface StatementOfMarks {
  student: StatementStudent;
  subjects: StatementSubject[];
  totalMarks: number;
  maxTotalMarks: number;
  percentage: number;
  cgpa: string;
  /** Credit-weighted SGPA (2 dp) when the Result stored one. */
  sgpa?: number | null;
  /** Equivalent percentage (CGPA × 9.5), 2 dp; null/absent when unavailable. */
  equivalentPercentage?: number | null;
  resultStatus: "PASS" | "FAIL" | "COMPARTMENT" | string;
  remarks?: string;
  declaredDate: string;
}
