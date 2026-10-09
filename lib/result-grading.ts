/**
 * Result academic calculations — THE single source of truth.
 *
 * This module is the ONLY place that knows how marks become grades, grade
 * points and the academic headline figures. Imported by:
 *   - app/api/admin/results/route.ts — AUTHORITATIVE: every POST/PUT derives
 *     totals, grade, grade point, SGPA, CGPA and equivalent percentage here and
 *     never stores client-supplied derived values.
 *   - app/admin/results/page.tsx — read-only preview only.
 *   - components/results/result-document.tsx — the printed legend/figures.
 *   - scripts/test-result-grading.ts — offline verification of the rules.
 *
 * MSU rules (MARKS ranges, NOT percentage bands):
 *   Marks    91-100 O  10 | 81-90 A+ 9 | 71-80 A 8 | 61-70 B+ 7
 *            51-60 B 6 | 41-50 C 5 | 33-40 P 4 | 0-32 F 0 | Absent AB 0
 *
 *   Subject Total         = internalMarks + externalMarks
 *   Subject Percentage    = (total / maximum) x 100   (result-level percentage)
 *   Grade + Grade Point   = from the SUBJECT TOTAL MARKS via MSU_GRADE_TABLE
 *   SGPA                  = sum(credits x grade points) / sum credits, 2 dp
 *   CGPA                  = sum(all credits x grade points) / sum credits
 *   Equivalent Percentage = CGPA x 9.5, 2 dp
 *   dp= digits after decimal points
 * There is deliberately NO nearest-integer or marks/10 shortcut: the letter
 * grade and grade point always come from the range table, and ABSENT is carried
 * explicitly (never collapsed into a bare zero).
 */

import type { SubjectType } from "@/lib/programme-structure";

/* ── MSU grade table (marks-based) ─────────────────────────────── */

export type MsuGrade = "O" | "A+" | "A" | "B+" | "B" | "C" | "P" | "F";

/** The grade recorded for an absent candidate. */
export const ABSENT_GRADE = "AB";

export type MsuGradeBand = {
  readonly grade: MsuGrade;
  readonly gradePoint: number;
  readonly minMarks: number;
  readonly maxMarks: number;
};

/**
 * The authoritative MSU marks -> grade / grade-point table.
 * Bands are evaluated in order; the first `marks >= minMarks` wins, so the
 * inclusive boundaries are exactly: 91, 81, 71, 61, 51, 41, 33.
 */
export const MSU_GRADE_TABLE: readonly MsuGradeBand[] = [
  { grade: "O", gradePoint: 10, minMarks: 91, maxMarks: 100 },
  { grade: "A+", gradePoint: 9, minMarks: 81, maxMarks: 90 },
  { grade: "A", gradePoint: 8, minMarks: 71, maxMarks: 80 },
  { grade: "B+", gradePoint: 7, minMarks: 61, maxMarks: 70 },
  { grade: "B", gradePoint: 6, minMarks: 51, maxMarks: 60 },
  { grade: "C", gradePoint: 5, minMarks: 41, maxMarks: 50 },
  { grade: "P", gradePoint: 4, minMarks: 33, maxMarks: 40 },
  { grade: "F", gradePoint: 0, minMarks: 0, maxMarks: 32 },
] as const;

/** Grade + grade point derived for one subject. */
export type SubjectGrade = { grade: string; gradePoint: number };

/**
 * Derive the letter grade and grade point for a subject.
 * @param marks  The subject TOTAL marks (internal + external).
 * @param absent True when the candidate was absent for the subject.
 * Never rounds and never divides: the range table is the only rule.
 */
export function gradeForMarks(marks: number, absent = false): SubjectGrade {
  if (absent) return { grade: ABSENT_GRADE, gradePoint: 0 };
  if (!Number.isFinite(marks) || marks < 0) return { grade: "F", gradePoint: 0 };

  for (const band of MSU_GRADE_TABLE) {
    if (marks >= band.minMarks) {
      return { grade: band.grade, gradePoint: band.gradePoint };
    }
  }
  return { grade: "F", gradePoint: 0 };
}

/* ── Per-subject status ────────────────────────────────────────── */

/** The status printed for one subject on the Statement of Marks. */
export type SubjectStatus = "Pass" | "Fail" | "Absent" | "Compartment";

/**
 * Minimum passing percentage by subject kind.
 *
 * This is a SEPARATE business rule from the MSU grade table: a subject can carry
 * the grade P (33–40 marks) and still be reported "Fail" here when its marks
 * percentage is below the applicable minimum. Grade and grade point are never
 * altered to match these thresholds.
 */
export const THEORY_PASS_PERCENTAGE = 36;
export const PRACTICAL_PASS_PERCENTAGE = 40;

/**
 * A subject is examined as Practical only when its curriculum type says so
 * (ProgrammeStructure is the single source of truth for a subject's type). A
 * legacy Result with no stored type is treated as Theory.
 */
export function isPracticalSubjectType(
  subjectType: string | null | undefined
): boolean {
  return subjectType === "PRACTICAL";
}

/** The minimum passing percentage for a subject kind (Practical 40%, else 36%). */
export function passingPercentage(
  subjectType: string | null | undefined
): number {
  return isPracticalSubjectType(subjectType)
    ? PRACTICAL_PASS_PERCENTAGE
    : THEORY_PASS_PERCENTAGE;
}

/** Fields needed to derive one subject's printed status. */
export type SubjectStatusInput = {
  /** Subject total marks (internal + external). */
  totalMarks: number;
  /** The subject's OWN maximum marks — never assumed to be 100. */
  maxMarks: number;
  /** Curriculum subject type; Practical subjects use the 40% minimum. */
  subjectType?: string | null;
  isAbsent?: boolean;
  isBacklog?: boolean;
};

/**
 * Derive the status printed for ONE subject (server-authoritative).
 *
 * Precedence:
 *   1. absent             -> "Absent"
 *   2. compartment flag   -> "Compartment"
 *   3. percentage below the subject's passing minimum -> "Fail"
 *   4. otherwise          -> "Pass"
 *
 * The percentage uses the subject's ACTUAL maximum, and the minimum is 40% for
 * a Practical subject and 36% for a Theory subject.
 */
export function subjectStatus(subject: SubjectStatusInput): SubjectStatus {
  if (subject.isAbsent) return "Absent";
  if (subject.isBacklog) return "Compartment";
  const minimum = passingPercentage(subject.subjectType);
  return subjectPercentage(subject.totalMarks, subject.maxMarks) >= minimum
    ? "Pass"
    : "Fail";
}

/**
 * Derive the semester result status from the per-subject statuses.
 *
 *   FAIL  when any subject is "Fail" or "Absent"
 *   PASS  otherwise
 *
 * A "Compartment" subject does NOT make the semester fail, and there is no
 * "Compartment" semester status: the flag is reported on the subject row only.
 */
export function semesterResultStatus(
  statuses: readonly SubjectStatus[]
): "PASS" | "FAIL" {
  return statuses.some((status) => status === "Fail" || status === "Absent")
    ? "FAIL"
    : "PASS";
}

/* ── Subject-level figures ─────────────────────────────────────── */

/** Subject total is always internal + external. */
export function subjectTotal(internalMarks: number, externalMarks: number): number {
  return internalMarks + externalMarks;
}

/**
 * Subject percentage = (total / maximum) x 100 as a RAW number.
 * Used only for the result-level percentage; grade/grade point never use it.
 */
export function subjectPercentage(totalMarks: number, maxMarks: number): number {
  if (!(maxMarks > 0)) return 0;
  return (totalMarks / maxMarks) * 100;
}

/** Round to 2 decimal places — the shared precision rule for GPA figures. */
export function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ── Subject record building (server-authoritative) ────────────── */

/**
 * Academic metadata snapshotted for a subject. On a curriculum-linked Result
 * this comes from the resolved ProgrammeStructure — never from the request.
 */
export type SubjectSnapshot = {
  subjectCode: string;
  subjectName: string;
  credits: number;
  maxMarks: number;
  subjectType: SubjectType | null;
  /**
   * Curriculum component maxima. Optional on legacy/manual Results that carry
   * no split — when absent only the TOTAL maximum (`maxMarks`) applies.
   *
   * The Result domain has exactly two mark components (internal + external); a
   * practical component is entered inside the EXTERNAL field, so the external
   * ceiling is `externalMax + practicalMax`. For a standard 25/75 theory paper
   * `practicalMax` is 0, so the ceiling is exactly the configured 75.
   */
  internalMax?: number | null;
  externalMax?: number | null;
  practicalMax?: number | null;
};

/**
 * What a client may send for one subject.
 *
 * Only the raw inputs are honoured: the component marks and whether the
 * candidate was absent. `grade`, `gradePoint`, `totalMarks` and `percentage`
 * are accepted in the type only so that a client sending them is a NORMAL case
 * — every one of them is ignored and derived below.
 */
export type SubjectSubmission = {
  internalMarks?: unknown;
  externalMarks?: unknown;
  isAbsent?: unknown;
  isBacklog?: unknown;
  grade?: unknown;
  gradePoint?: unknown;
  totalMarks?: unknown;
  percentage?: unknown;
};

/** A Result subject as stored (server-derived total, grade and grade point). */
export type ResultSubject = {
  subjectCode: string;
  subjectName: string;
  internalMarks: number;
  externalMarks: number;
  totalMarks: number;
  maxMarks: number;
  grade: string;
  gradePoint: number;
  credits: number;
  subjectType: SubjectType | null;
  isBacklog: boolean;
  isAbsent: boolean;
};

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A provided non-negative number, or null when the snapshot does not define it. */
function optionalNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Build one stored Result subject from a snapshot + the admin's submission.
 *
 * Calculation path (server-side, authoritative):
 *   internal + external -> subject total -> MSU grade table -> grade + point
 *
 * The snapshot's credits / maximum / name / type always win; any client-supplied
 * grade, gradePoint, totalMarks or percentage is ignored by construction.
 * An absent subject is stored with zero marks and the explicit AB grade.
 */
export function buildResultSubject(
  snapshot: SubjectSnapshot,
  submission: SubjectSubmission
): { ok: true; subject: ResultSubject } | { ok: false; error: string } {
  const at = snapshot.subjectCode;
  const isAbsent = submission.isAbsent === true;

  let internalMarks: number;
  let externalMarks: number;

  if (isAbsent) {
    // Absence is not a zero: keep the marks at zero but record AB explicitly.
    internalMarks = 0;
    externalMarks = 0;
  } else {
    if (!nonNegative(submission.internalMarks)) {
      return { ok: false, error: `Subject "${at}": internalMarks must be a non-negative number.` };
    }
    if (!nonNegative(submission.externalMarks)) {
      return { ok: false, error: `Subject "${at}": externalMarks must be a non-negative number.` };
    }
    internalMarks = submission.internalMarks;
    externalMarks = submission.externalMarks;
  }

  const totalMarks = subjectTotal(internalMarks, externalMarks);

  // Per-component ceilings from the curriculum. An absent subject is exempt:
  // its marks are already forced to 0 above. When the snapshot defines no
  // component maximum the total check below is the only constraint.
  if (!isAbsent) {
    const internalMax = optionalNonNegative(snapshot.internalMax);
    if (internalMax !== null && internalMarks > internalMax) {
      return {
        ok: false,
        error: `Subject "${at}": internalMarks cannot exceed the curriculum internal maximum (${internalMax}).`,
      };
    }

    const externalMax = optionalNonNegative(snapshot.externalMax);
    if (externalMax !== null) {
      // Practical marks are entered in the External field, so the practical
      // maximum raises the external ceiling; the total check still applies.
      const externalLimit = externalMax + (optionalNonNegative(snapshot.practicalMax) ?? 0);
      if (externalMarks > externalLimit) {
        return {
          ok: false,
          error: `Subject "${at}": externalMarks cannot exceed the curriculum external maximum (${externalLimit}).`,
        };
      }
    }
  }

  if (totalMarks > snapshot.maxMarks) {
    return {
      ok: false,
      error: `Subject "${at}": internal + external marks cannot exceed the curriculum maximum (${snapshot.maxMarks}).`,
    };
  }

  const { grade, gradePoint } = gradeForMarks(totalMarks, isAbsent);

  return {
    ok: true,
    subject: {
      subjectCode: snapshot.subjectCode,
      subjectName: snapshot.subjectName,
      internalMarks,
      externalMarks,
      totalMarks,
      maxMarks: snapshot.maxMarks,
      grade,
      gradePoint,
      credits: snapshot.credits,
      subjectType: snapshot.subjectType ?? null,
      isBacklog: submission.isBacklog === true,
      isAbsent,
    },
  };
}

/* ── Result-level figures ──────────────────────────────────────── */

/** The per-subject fields the result-level figures are derived from. */
export type ResultFigureSubject = {
  totalMarks: number;
  maxMarks: number;
  credits: number;
  gradePoint: number;
};

export type ResultFigures = {
  totalMarks: number;
  maxTotalMarks: number;
  /** Total / maximum x 100, rounded to 2 dp. */
  percentage: number;
  /** sum(credits x grade points) / sum credits, 2 dp; null if no credits. */
  sgpa: number | null;
};

/** sum(credits x grade points) / sum credits, rounded to 2 dp. */
export function computeSgpa(
  subjects: readonly { credits: number; gradePoint: number }[]
): number | null {
  const totalCredits = subjects.reduce((sum, s) => sum + s.credits, 0);
  if (totalCredits <= 0) return null;
  const weighted = subjects.reduce((sum, s) => sum + s.credits * s.gradePoint, 0);
  return roundTo2(weighted / totalCredits);
}

/**
 * Result-level headline computed purely from the stored subjects.
 * Takes ONLY subjects — a client payload can never be an input here.
 */
export function computeResultFigures(subjects: readonly ResultFigureSubject[]): ResultFigures {
  const totalMarks = subjects.reduce((sum, s) => sum + s.totalMarks, 0);
  const maxTotalMarks = subjects.reduce((sum, s) => sum + s.maxMarks, 0);
  return {
    totalMarks,
    maxTotalMarks,
    percentage: maxTotalMarks > 0 ? roundTo2((totalMarks / maxTotalMarks) * 100) : 0,
    sgpa: computeSgpa(subjects),
  };
}

export type CurriculumResultFigures = ResultFigures & {
  /**
   * CGPA is produced by the cumulative `calculateCGPA` pass once the student's
   * other semester Results are collected, so it is a null placeholder here.
   */
  cgpa: null;
  equivalentPercentage: null;
};

/** The authoritative headline for a curriculum-linked Result. */
export function curriculumResultFigures(
  subjects: readonly ResultFigureSubject[]
): CurriculumResultFigures {
  return { ...computeResultFigures(subjects), cgpa: null, equivalentPercentage: null };
}

/* ── Cumulative CGPA ───────────────────────────────────────────── */

/**
 * One semester's contribution to the cumulative CGPA. Only credits and grade
 * points matter: the cumulative figure is credit-weighted.
 */
export type CgpaSemester = {
  semesterNumber: number;
  subjects: readonly { credits: number; gradePoint: number }[];
};

/**
 * Cumulative CGPA across a student's included semesters.
 *
 *   CGPA = sum(all included credits x grade points) / sum(all credits)
 *
 * Credit-weighted, and deliberately NOT the arithmetic mean of the SGPAs.
 * Returns null when there are no credits to weight.
 */
export function calculateCGPA(semesters: readonly CgpaSemester[]): number | null {
  let totalCredits = 0;
  let weightedPoints = 0;

  for (const semester of semesters) {
    for (const subject of semester.subjects) {
      totalCredits += subject.credits;
      weightedPoints += subject.credits * subject.gradePoint;
    }
  }

  if (totalCredits <= 0) return null;
  return roundTo2(weightedPoints / totalCredits);
}

/**
 * Serialise a cumulative CGPA to the model's stored `string | null` shape,
 * fixed at 2 decimal places. `null` stays null (no credits / legacy Result).
 */
export function formatCgpa(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

/* ── Equivalent percentage ─────────────────────────────────────── */

/**
 * Equivalent Percentage = CGPA x 9.5, rounded to 2 dp.
 *
 * Derived from the cumulative CGPA only — never from subject marks and never
 * from SGPA when a CGPA exists. Returns null when no CGPA is available.
 */
export function equivalentPercentage(cgpa: number | null): number | null {
  if (cgpa === null || !Number.isFinite(cgpa)) return null;
  return roundTo2(cgpa * 9.5);
}
