/**
 * Result academic calculations (Phase 3B) — pure rules, no I/O.
 *
 * This module is the SINGLE source of truth for how a Result's marks become
 * its academic figures. It is imported by:
 *   - app/api/admin/results/route.ts — AUTHORITATIVE: every curriculum-linked
 *     POST/PUT recalculates here and never stores client-supplied totals,
 *     percentages, grade points, SGPA or CGPA.
 *   - app/admin/results/page.tsx — live preview only (server recalculates on
 *     save, so the preview can never disagree with what is stored).
 *   - scripts/test-result-grading.ts — offline verification of the rules.
 *
 * Rules (exactly as specified in Phase 3B):
 *   Subject Total      = internalMarks + externalMarks
 *   Subject Percentage = (subject total / subject maximum) × 100  — raw number
 *   Grade Point        = 10-point scale below, from the ACTUAL numeric
 *                        percentage (never rounded display text, and NEVER
 *                        from the manually entered letter Grade)
 *   SGPA               = Σ(credits × grade points) / Σ credits, rounded to
 *                        2 decimal places
 *   CGPA (Phase 3C)    = Σ(credits × grade points) over EVERY included
 *                        semester of the same student ÷ Σ credits over those
 *                        semesters, rounded to 2 decimal places. This is a
 *                        credit-weighted cumulative figure — never a plain
 *                        average of SGPAs (see calculateCGPA).
 *
 * The letter Grade is a MANUAL field: it is only ever passed through here,
 * never computed, never rewritten.
 *
 * Precision: grade points are exact integers (0, 5, 6, 7, 8, 9, 10);
 * percentage and SGPA are rounded to 2 decimal places, matching the existing
 * Result conventions (the previous client-side percentage rounding and the
 * statement's `toFixed(2)` GPA display).
 */

import type { SubjectType } from "@/lib/programme-structure";

/* ── Grade point scale ─────────────────────────────────────────── */

/**
 * Percentage → grade point bands, evaluated top-down on the RAW percentage:
 * 90.0 → 10, 89.9 → 9, 40.0 → 5, 39.9 → 0 (fail).
 */
const GRADE_POINT_BANDS: { readonly minInclusive: number; readonly gradePoint: number }[] = [
  { minInclusive: 90, gradePoint: 10 },
  { minInclusive: 80, gradePoint: 9 },
  { minInclusive: 70, gradePoint: 8 },
  { minInclusive: 60, gradePoint: 7 },
  { minInclusive: 50, gradePoint: 6 },
  { minInclusive: 40, gradePoint: 5 },
  { minInclusive: 0, gradePoint: 0 },
];

/**
 * Grade point for a subject percentage.
 * Input must be the actual numeric percentage (e.g. 89.9), not rounded text.
 */
export function gradePointForPercentage(percentage: number): number {
  if (!Number.isFinite(percentage) || percentage < 0) return 0;
  for (const band of GRADE_POINT_BANDS) {
    if (percentage >= band.minInclusive) return band.gradePoint;
  }
  return 0;
}

/* ── Subject-level figures ─────────────────────────────────────── */

/** Subject total is always internal + external. */
export function subjectTotal(internalMarks: number, externalMarks: number): number {
  return internalMarks + externalMarks;
}

/**
 * Subject percentage = (total / maximum) × 100 as a RAW number.
 * Returns 0 when the maximum is not positive (a curriculum-linked Result
 * always has a positive maximum; the guard only prevents a divide-by-zero
 * preview for blank legacy rows).
 */
export function subjectPercentage(totalMarks: number, maxMarks: number): number {
  if (!(maxMarks > 0)) return 0;
  return (totalMarks / maxMarks) * 100;
}

/** Round to 2 decimal places — the shared precision rule for percentage/SGPA. */
export function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ── Subject record building (server-authoritative) ────────────── */

/**
 * Academic metadata snapshotted for a subject. On a curriculum-linked Result
 * this comes from the Phase 3A snapshot (or the resolved ProgrammeStructure
 * at creation time) — never from the request.
 */
export type SubjectSnapshot = {
  subjectCode: string;
  subjectName: string;
  credits: number;
  maxMarks: number;
  subjectType: SubjectType | null;
};

/**
 * What a client may send for one subject.
 *
 * `grade` is the manually entered letter grade and is accepted as-is.
 * `gradePoint`, `totalMarks` and `percentage` are accepted in the type only so
 * that a client sending them is a NORMAL case — every one of them is ignored
 * and recalculated below.
 */
export type SubjectSubmission = {
  internalMarks?: unknown;
  externalMarks?: unknown;
  grade?: unknown;
  isBacklog?: unknown;
  gradePoint?: unknown;
  totalMarks?: unknown;
  percentage?: unknown;
};

/** A Result subject as stored (server-calculated totals and grade point). */
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
};

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Build one stored Result subject from a snapshot + the admin's submission.
 *
 * Calculation path (server-side, authoritative):
 *   internal + external → subject total → subject percentage → grade point
 *
 * The snapshot's credits / maximum / name / type always win; the manual Grade
 * passes through untouched; any client-supplied gradePoint, totalMarks or
 * percentage is ignored by construction.
 */
export function buildResultSubject(
  snapshot: SubjectSnapshot,
  submission: SubjectSubmission
): { ok: true; subject: ResultSubject } | { ok: false; error: string } {
  const at = snapshot.subjectCode;

  if (!nonNegative(submission.internalMarks)) {
    return { ok: false, error: `Subject "${at}": internalMarks must be a non-negative number.` };
  }
  if (!nonNegative(submission.externalMarks)) {
    return { ok: false, error: `Subject "${at}": externalMarks must be a non-negative number.` };
  }

  const grade = typeof submission.grade === "string" ? submission.grade.trim() : "";
  if (!grade) {
    return { ok: false, error: `Subject "${at}": grade is required.` };
  }

  const internalMarks = submission.internalMarks;
  const externalMarks = submission.externalMarks;
  const totalMarks = subjectTotal(internalMarks, externalMarks);

  if (totalMarks > snapshot.maxMarks) {
    return {
      ok: false,
      error: `Subject "${at}": internal + external marks cannot exceed the curriculum maximum (${snapshot.maxMarks}).`,
    };
  }

  const percentage = subjectPercentage(totalMarks, snapshot.maxMarks);

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
      gradePoint: gradePointForPercentage(percentage),
      credits: snapshot.credits,
      subjectType: snapshot.subjectType ?? null,
      isBacklog: submission.isBacklog === true,
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
  /** Total ÷ maximum × 100, rounded to 2 dp (existing Result convention). */
  percentage: number;
  /** Σ(credits × grade points) ÷ Σ credits, rounded to 2 dp; null if no credits. */
  sgpa: number | null;
};

/** Σ(credits × grade points) ÷ Σ credits, rounded to 2 dp. */
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
   * The single-term CGPA placeholder kept for callers that only have one
   * semester in hand. The cumulative value is produced by `calculateCGPA`
   * once the student's other semester Results are collected (Phase 3C).
   */
  cgpa: null;
};

/** The authoritative headline for a curriculum-linked Result. */
export function curriculumResultFigures(
  subjects: readonly ResultFigureSubject[]
): CurriculumResultFigures {
  return { ...computeResultFigures(subjects), cgpa: null };
}

/* ── Cumulative CGPA (Phase 3C) ────────────────────────────────── */

/**
 * One semester's contribution to the cumulative CGPA.
 *
 * Only the subject credits and grade points matter: the cumulative figure is
 * credit-weighted, so a semester with more credits pulls the CGPA further.
 */
export type CgpaSemester = {
  semesterNumber: number;
  subjects: readonly { credits: number; gradePoint: number }[];
};

/**
 * Cumulative CGPA across a student's included semesters.
 *
 *   CGPA = Σ(all included subject credits × grade points)
 *          ───────────────────────────────────────────────
 *                    Σ(all included subject credits)
 *
 * This is equivalent to weighting each semester's SGPA by that semester's
 * credit total, and is deliberately NOT the arithmetic mean of the SGPAs:
 * with unequal credit totals the two differ (that is the point).
 *
 * Pure by construction — the caller passes the semester Results it already
 * retrieved; no database access happens here. Returns null when there are no
 * credits to weight (e.g. an empty set of semesters).
 */
export function calculateCGPA(
  semesters: readonly CgpaSemester[]
): number | null {
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
 *
 * Precision rule: CGPA uses the SAME 2-decimal precision as SGPA and
 * percentage, so every academic headline in the project agrees.
 */
export function formatCgpa(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}
