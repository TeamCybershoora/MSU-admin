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
  isBacklog: boolean;
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
  description?: string;
}

/** Everything the Statement of Marks needs to render. */
export interface StatementOfMarks {
  student: StatementStudent;
  subjects: StatementSubject[];
  totalMarks: number;
  maxTotalMarks: number;
  percentage: number;
  cgpa: string;
  resultStatus: "PASS" | "FAIL" | "COMPARTMENT" | string;
  remarks?: string;
  declaredDate: string;
}
