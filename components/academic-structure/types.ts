/**
 * Shared client-side types for the Academic Structure admin UI.
 *
 * These mirror the shapes returned by /api/admin/academic-structure. The
 * controlled vocabulary (statuses, subject types, limits) and the shared rules
 * live in @/lib/programme-structure and are imported from there, so the browser
 * and the server can never disagree about what is valid.
 */

import {
  ELECTIVE_SELECTION_RULE_LABELS,
  SUBJECT_CATEGORY_LABELS,
  SUBJECT_TYPE_LABELS,
  type ElectiveSelectionRule,
  type ProgrammeStructureStatus,
  type SubjectCategory,
  type SubjectType,
} from "@/lib/programme-structure";

/** Maximum-assessment structure of one subject (never a student's marks). */
export interface AssessmentRecord {
  internalMax: number;
  externalMax: number;
  practicalMax: number;
  /** Always internal + external + practical (derived server-side). */
  totalMax: number;
  /** Pass/qualifying marks, or null when the source states none. */
  minimumMarks: number | null;
  /** True when the internal component is qualifying, not numerically marked. */
  internalQualifying: boolean;
}

/** One subject definition inside a semester. */
export interface CurriculumSubject {
  subjectCode: string;
  subjectName: string;
  credits: number;
  subjectType: SubjectType;
  category: SubjectCategory;
  status: ProgrammeStructureStatus;
  /** "" = compulsory; otherwise e.g. "ELECTIVE-I". */
  electiveGroup: string;
  /** ANY_ONE while the subject is an elective option; null when compulsory. */
  selectionRule: ElectiveSelectionRule | null;
  assessment: AssessmentRecord;
}

/** One semester of a curriculum. */
export interface CurriculumSemester {
  semesterNumber: number;
  semesterName: string;
  status: ProgrammeStructureStatus;
  subjectCount: number;
  subjects: CurriculumSubject[];
}

/** List-row shape (identity, status and counts only). */
export interface ProgrammeStructureSummary {
  id: string;
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: ProgrammeStructureStatus;
  semesterCount: number;
  subjectCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Full shape, including the whole curriculum. */
export interface ProgrammeStructureRecord extends ProgrammeStructureSummary {
  semesters: CurriculumSemester[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ProgrammeStructureFilters {
  statuses: ProgrammeStructureStatus[];
  programmes: string[];
  academicSessions: string[];
}

/* ── Display helpers ───────────────────────────────────────────── */

/** Badge variant for a status value (ACTIVE reads as healthy, INACTIVE as muted). */
export function statusBadgeVariant(
  status: ProgrammeStructureStatus
): "success" | "neutral" {
  return status === "ACTIVE" ? "success" : "neutral";
}

export function subjectTypeLabel(type: SubjectType): string {
  return SUBJECT_TYPE_LABELS[type] ?? type;
}

export function subjectCategoryLabel(category: SubjectCategory): string {
  return SUBJECT_CATEGORY_LABELS[category] ?? category;
}

export function selectionRuleLabel(rule: ElectiveSelectionRule | null): string {
  return rule ? (ELECTIVE_SELECTION_RULE_LABELS[rule] ?? rule) : "";
}

/** Semester display label: the custom name when set, otherwise the number. */
export function semesterLabel(semester: {
  semesterNumber: number;
  semesterName: string;
}): string {
  return semester.semesterName?.trim() || `Semester ${semester.semesterNumber}`;
}

/**
 * "30 + 70 = 100" — only the components that apply (> 0) are listed, so a
 * theory-only subject reads "30 + 70" and a theory + practical subject reads
 * "30 + 50 + 20 = 100". The total shown is always the derived one.
 *
 * A qualifying internal reads "Qualifying" (the source gives no number for it),
 * and a stated pass mark is appended as "· Min 40". Values the curriculum does
 * not state are never rendered as 0 or as an invented split.
 */
export function formatAssessment(assessment: AssessmentRecord): string {
  const parts: string[] = [];

  if (assessment.internalQualifying) parts.push("Qualifying");
  else if (assessment.internalMax > 0) parts.push(String(assessment.internalMax));

  if (assessment.externalMax > 0) parts.push(String(assessment.externalMax));
  if (assessment.practicalMax > 0) parts.push(String(assessment.practicalMax));

  const structure =
    parts.length === 0
      ? String(assessment.totalMax)
      : `${parts.join(" + ")} = ${assessment.totalMax}`;

  return assessment.minimumMarks === null
    ? structure
    : `${structure} · Min ${assessment.minimumMarks}`;
}

/** Assessment values used when opening the subject form for a new subject. */
export function emptyAssessment(): AssessmentRecord {
  return {
    internalMax: 0,
    externalMax: 0,
    practicalMax: 0,
    totalMax: 0,
    minimumMarks: null,
    internalQualifying: false,
  };
}

/* ── Elective groups ───────────────────────────────────────────── */

/** One elective group and the alternative subjects a student may choose from. */
export interface ElectiveGroup {
  code: string;
  selectionRule: ElectiveSelectionRule | null;
  options: CurriculumSubject[];
}

/**
 * Split a semester's subjects into its compulsory papers and its elective groups.
 *
 * Subjects sharing an `electiveGroup` are ALTERNATIVES of one another (never all
 * compulsory), which is what the UI must show — the group's rule is taken from
 * its members (the server validates that a group never mixes rules).
 */
export function partitionSubjects(subjects: CurriculumSubject[]): {
  compulsory: CurriculumSubject[];
  groups: ElectiveGroup[];
} {
  const compulsory: CurriculumSubject[] = [];
  const byGroup = new Map<string, CurriculumSubject[]>();

  for (const subject of subjects) {
    if (!subject.electiveGroup) {
      compulsory.push(subject);
      continue;
    }

    const list = byGroup.get(subject.electiveGroup) ?? [];
    list.push(subject);
    byGroup.set(subject.electiveGroup, list);
  }

  return {
    compulsory,
    groups: Array.from(byGroup.entries()).map(([code, options]) => ({
      code,
      selectionRule: options[0]?.selectionRule ?? null,
      options,
    })),
  };
}
