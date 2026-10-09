/**
 * Programme Structure / Curriculum — shared vocabulary, validation and pure
 * business rules.
 *
 * WHY THIS MODULE EXISTS:
 * Programme Structure is MASTER ACADEMIC DATA — the single definition of what a
 * programme teaches in one academic session:
 *
 *   Programme → Academic Session → Semester → Subject → Academic metadata
 *
 * Later phases consume exactly this definition: Syllabus will attach documents
 * to the subjects that are defined here, and Result will build student result
 * rows from the same subject list (credits + assessment structure). Keeping the
 * rules in one dependency-free module means the API routes and the admin UI
 * apply the identical rules, so a subject can never be valid in the browser and
 * invalid on the server.
 *
 * WHY IT IS PURE:
 * No Mongoose, no database and no environment access — only local constants and
 * the shared string parsers in @/lib/validation. That makes the business rules
 * directly testable offline (scripts/test-programme-structure-validation.ts) and
 * safe to import from client components.
 */

import { parseProgrammeCode, parseSemesterNumber } from "@/lib/validation";

/* ── Controlled vocabulary ─────────────────────────────────────── */

/**
 * Status of a programme structure, a semester or a subject.
 *
 * A single ACTIVE/INACTIVE pair is used at every level. There is deliberately
 * NO separate status for credits, marks or subject type: those are properties
 * of the subject, so deactivating the SUBJECT is what makes them unavailable
 * (see effectiveStatus below) — the individual values are never mutated.
 */
export const STRUCTURE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ProgrammeStructureStatus = (typeof STRUCTURE_STATUSES)[number];

/**
 * Minimal controlled set of subject types. The set is intentionally small and
 * defined in exactly one place, so adding a type later is a one-line change
 * rather than a hunt through validators, schemas and forms.
 */
export const SUBJECT_TYPES = ["THEORY", "PRACTICAL", "THEORY_PRACTICAL"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** Display labels for the subject types above. */
export const SUBJECT_TYPE_LABELS: Record<SubjectType, string> = {
  THEORY: "Theory",
  PRACTICAL: "Practical",
  THEORY_PRACTICAL: "Theory + Practical",
};

/**
 * Category of a subject — a second, orthogonal classification that subjectType
 * cannot express on its own.
 *
 * A VALUE_ADDED course is examined like any other subject but is recognised
 * separately by the university (for example the BCA "Environmental Studies"
 * course, which is 2 credits and qualifying rather than a normal 4-credit
 * theory paper). Without this, the only way to store it would be to distort its
 * type or its credits.
 */
export const SUBJECT_CATEGORIES = ["CORE", "VALUE_ADDED"] as const;
export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

export const SUBJECT_CATEGORY_LABELS: Record<SubjectCategory, string> = {
  CORE: "Core",
  VALUE_ADDED: "Value Added",
};

/**
 * How the options inside an ELECTIVE group are chosen.
 *
 * ANY_ONE is the only rule the verified BCA curriculum states (ELECTIVE-I and
 * ELECTIVE-II are both "any one of the following"), so the controlled set holds
 * exactly that. It is the single extension point if another rule is ever
 * verified — no other rule is invented here.
 */
export const ELECTIVE_SELECTION_RULES = ["ANY_ONE"] as const;
export type ElectiveSelectionRule = (typeof ELECTIVE_SELECTION_RULES)[number];

export const ELECTIVE_SELECTION_RULE_LABELS: Record<
  ElectiveSelectionRule,
  string
> = {
  ANY_ONE: "Select any one",
};

/**
 * Name of the elective group a subject belongs to, e.g. "ELECTIVE-I".
 *
 * An EMPTY string means the subject is compulsory. Subjects sharing the same
 * group name are ALTERNATIVES of one another, never simultaneously compulsory —
 * which is what Result Management will later need in order to decide which
 * subjects a student can actually take. The rule is stored per subject so the
 * flat `subjects[]` shape (and every existing consumer of it) is preserved; a
 * semester validates that all members of a group agree on the rule.
 */
export type SubjectElectiveGroup = string;

/* ── Limits ────────────────────────────────────────────────────── */

/** Semesters per structure — aligned with the existing Syllabus 1–12 range. */
export const MAX_SEMESTERS_PER_STRUCTURE = 12;
/** Subjects per semester — aligned with the existing Syllabus model limit. */
export const MAX_SUBJECTS_PER_SEMESTER = 30;
export const MAX_SUBJECT_CODE_LENGTH = 30;
export const MAX_SUBJECT_NAME_LENGTH = 200;
export const MAX_PROGRAMME_NAME_LENGTH = 150;
export const MAX_SEMESTER_NAME_LENGTH = 60;
export const MAX_ELECTIVE_GROUP_CODE_LENGTH = 40;
export const MAX_CREDITS = 100;
export const MAX_MARKS_PER_COMPONENT = 1000;

/** Academic session label, e.g. "2025-26" or "2025-2026". */
export const ACADEMIC_SESSION_PATTERN = /^\d{4}-\d{2,4}$/;

/**
 * Subject code pattern — intentionally permissive, matching the identifiers
 * already used in this repository ("BCA-101", "CS401"): a leading letter/digit
 * followed by letters, digits, spaces, dots, underscores, slashes or hyphens.
 * Only the shape is constrained here; uniqueness is enforced per
 * programme + session + semester, never globally.
 */
export const SUBJECT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,29}$/;

/* ── Result helper type ────────────────────────────────────────── */

/** Discriminated result used by every validator below. */
export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

/* ── Normalised input shapes ───────────────────────────────────── */

/** Maximum-assessment structure of one subject (never a student's marks). */
export interface AssessmentInput {
  internalMax: number;
  externalMax: number;
  practicalMax: number;
  /** Always derived as internalMax + externalMax + practicalMax. */
  totalMax: number;
  /**
   * Pass/qualifying marks for the paper, or null when the source does not state
   * one. This is a threshold on the SAME maximum structure above, not a grade —
   * grade/grade-point/SGPA/CGPA stay in Result logic.
   */
  minimumMarks: number | null;
  /**
   * True when the internal component is QUALIFYING rather than numerically
   * marked (the source prints "Internal: Qualifying" and gives no internal
   * maximum). When true, internalMax is 0 because there is no numeric maximum to
   * record — the qualification itself is a real assessment component, so the
   * information is kept instead of being flattened into "no internal".
   */
  internalQualifying: boolean;
}

export interface SubjectInput {
  subjectCode: string;
  subjectName: string;
  credits: number;
  subjectType: SubjectType;
  category: SubjectCategory;
  status: ProgrammeStructureStatus;
  /** Empty string = compulsory subject. */
  electiveGroup: SubjectElectiveGroup;
  /** Set (ANY_ONE) exactly when electiveGroup is set, otherwise null. */
  selectionRule: ElectiveSelectionRule | null;
  assessment: AssessmentInput;
}

export interface SemesterInput {
  /** Numeric identity of the semester (1–12). */
  semesterNumber: number;
  /** Display label only; may be empty. */
  semesterName: string;
  status: ProgrammeStructureStatus;
  subjects: SubjectInput[];
}

export interface ProgrammeStructureFields {
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: ProgrammeStructureStatus;
}

/* ── Vocabulary guards ─────────────────────────────────────────── */

export function isStructureStatus(
  value: unknown
): value is ProgrammeStructureStatus {
  return (
    typeof value === "string" &&
    (STRUCTURE_STATUSES as readonly string[]).includes(value)
  );
}

export function isSubjectType(value: unknown): value is SubjectType {
  return (
    typeof value === "string" &&
    (SUBJECT_TYPES as readonly string[]).includes(value)
  );
}

export function isSubjectCategory(value: unknown): value is SubjectCategory {
  return (
    typeof value === "string" &&
    (SUBJECT_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isElectiveSelectionRule(
  value: unknown
): value is ElectiveSelectionRule {
  return (
    typeof value === "string" &&
    (ELECTIVE_SELECTION_RULES as readonly string[]).includes(value)
  );
}

/* ── Effective status (parent → child availability) ────────────── */

/**
 * Effective availability of a child record.
 *
 * A parent INACTIVE makes every child effectively inactive WITHOUT touching the
 * children in the database:
 *
 *   Programme INACTIVE → the whole structure is unavailable
 *   Semester  INACTIVE → its subjects are effectively unavailable
 *   Subject   INACTIVE → only that subject is unavailable
 *
 * This is why deactivating a semester (or a whole programme) is a single
 * document update and never a cascading bulk write. The stored per-child status
 * is preserved, so reactivating the parent restores the exact previous state.
 */
export function effectiveStatus(
  parentStatus: ProgrammeStructureStatus,
  ownStatus: ProgrammeStructureStatus
): ProgrammeStructureStatus {
  return parentStatus === "INACTIVE" || ownStatus === "INACTIVE"
    ? "INACTIVE"
    : "ACTIVE";
}

/** Convenience wrapper: is this record usable for NEW selection? */
export function isEffectivelyActive(
  parentStatus: ProgrammeStructureStatus,
  ownStatus: ProgrammeStructureStatus
): boolean {
  return effectiveStatus(parentStatus, ownStatus) === "ACTIVE";
}

/* ── Assessment totals ─────────────────────────────────────────── */

/**
 * totalMax is ALWAYS the sum of the components — the client never gets to type
 * a total that disagrees with the parts. Components that do not apply are
 * represented as 0 (the existing Result domain already stores internal and
 * external components, with practical folded in as 0 when absent).
 */
export function computeTotalMax(component: {
  internalMax: number;
  externalMax: number;
  practicalMax: number;
}): number {
  return (
    Number(component.internalMax || 0) +
    Number(component.externalMax || 0) +
    Number(component.practicalMax || 0)
  );
}

/* ── Field parsers ─────────────────────────────────────────────── */

/** Non-negative integer (marks). Returns null when invalid. */
function parseMarksValue(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;

  if (!Number.isInteger(parsed) || parsed < 0) return null;
  if (parsed > MAX_MARKS_PER_COMPONENT) return null;
  return parsed;
}

/**
 * Credits: a non-negative number (decimals allowed, 0 = no credit-bearing
 * weight). Kept non-negative rather than positive so a definition can exist
 * before its credits are finalised — matching the "credits are a property of
 * the subject" rule.
 */
export function parseCredits(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN;

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CREDITS) return null;
  return parsed;
}

/** Academic session label, normalised to `YYYY-YY(YY)` or null when invalid. */
export function parseAcademicSession(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ACADEMIC_SESSION_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/* ── Assessment ────────────────────────────────────────────────── */

/**
 * Validate the maximum-assessment structure of ONE subject.
 *
 * Rules:
 *   - all three components default to 0 when omitted (not applicable). 0 is the
 *     established representation of "this component does not apply" — a lab with
 *     no internal maximum and a project with no internal/external split are both
 *     recorded that way rather than with invented numbers
 *   - every component must be a non-negative integer
 *   - at least one component must be above 0 (a subject with a 0/0/0 maximum
 *     cannot produce a result row later)
 *   - totalMax is DERIVED here; any client-sent totalMax is ignored, so an
 *     inconsistent total can never be stored
 *   - minimumMarks is optional (null = the source states none) and is never
 *     invented
 *   - internalQualifying marks an internal component that is qualifying instead
 *     of numerically marked, which is only coherent with internalMax 0
 */
export function parseAssessment(value: unknown): ValidationResult<AssessmentInput> {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Assessment structure is required." };
  }

  const raw = value as Record<string, unknown>;
  const component = { internalMax: 0, externalMax: 0, practicalMax: 0 };

  for (const field of ["internalMax", "externalMax", "practicalMax"] as const) {
    const supplied = raw[field];
    if (supplied === undefined || supplied === null || supplied === "") continue;

    const parsed = parseMarksValue(supplied);
    if (parsed === null) {
      return {
        ok: false,
        message: `${field} must be a non-negative whole number (0 when not applicable).`,
      };
    }
    component[field] = parsed;
  }

  const totalMax = computeTotalMax(component);
  if (totalMax <= 0) {
    return {
      ok: false,
      message: "Assessment structure must set at least one maximum above 0.",
    };
  }

  // Optional pass mark. Absent/null/"" means "not stated by the source" and is
  // stored as null — never defaulted to 0, which would mean "must score nothing".
  let minimumMarks: number | null = null;
  if (raw.minimumMarks !== undefined && raw.minimumMarks !== null && raw.minimumMarks !== "") {
    const parsed = parseMarksValue(raw.minimumMarks);
    if (parsed === null) {
      return {
        ok: false,
        message: "minimumMarks must be a non-negative whole number.",
      };
    }
    minimumMarks = parsed;
  }

  const internalQualifying = raw.internalQualifying === true;
  if (internalQualifying && component.internalMax > 0) {
    return {
      ok: false,
      message:
        "An internal component cannot be both qualifying and numerically marked (internalMax must be 0 when internalQualifying is true).",
    };
  }

  return {
    ok: true,
    data: { ...component, totalMax, minimumMarks, internalQualifying },
  };
}

/* ── Subject ───────────────────────────────────────────────────── */

/**
 * Validate ONE subject definition. `status` defaults to ACTIVE; the code is
 * normalised to uppercase so identity is unambiguous everywhere (matching the
 * repository's other code fields such as programme and roll number).
 */
export function parseSubjectInput(value: unknown): ValidationResult<SubjectInput> {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Subject is required." };
  }

  const raw = value as Record<string, unknown>;

  const subjectCode =
    typeof raw.subjectCode === "string" ? raw.subjectCode.trim().toUpperCase() : "";
  if (!subjectCode) {
    return { ok: false, message: "Subject code is required." };
  }
  if (!SUBJECT_CODE_PATTERN.test(subjectCode)) {
    return {
      ok: false,
      message: `Subject code must be 1-${MAX_SUBJECT_CODE_LENGTH} characters (letters, digits, spaces, dots, underscores, slashes or hyphens).`,
    };
  }

  const subjectName =
    typeof raw.subjectName === "string" ? raw.subjectName.trim() : "";
  if (!subjectName) {
    return { ok: false, message: `Subject ${subjectCode}: subject name is required.` };
  }
  if (subjectName.length > MAX_SUBJECT_NAME_LENGTH) {
    return {
      ok: false,
      message: `Subject ${subjectCode}: subject name cannot exceed ${MAX_SUBJECT_NAME_LENGTH} characters.`,
    };
  }

  const credits = parseCredits(raw.credits);
  if (credits === null) {
    return {
      ok: false,
      message: `Subject ${subjectCode}: credits must be a non-negative number (0-${MAX_CREDITS}).`,
    };
  }

  if (!isSubjectType(raw.subjectType)) {
    return {
      ok: false,
      message: `Subject ${subjectCode}: subject type must be one of ${SUBJECT_TYPES.join(", ")}.`,
    };
  }

  const assessment = parseAssessment(raw.assessment);
  if (!assessment.ok) {
    return { ok: false, message: `Subject ${subjectCode}: ${assessment.message}` };
  }

  const status = raw.status === undefined ? "ACTIVE" : raw.status;
  if (!isStructureStatus(status)) {
    return {
      ok: false,
      message: `Subject ${subjectCode}: status must be one of ${STRUCTURE_STATUSES.join(", ")}.`,
    };
  }

  const category = raw.category === undefined ? "CORE" : raw.category;
  if (!isSubjectCategory(category)) {
    return {
      ok: false,
      message: `Subject ${subjectCode}: category must be one of ${SUBJECT_CATEGORIES.join(", ")}.`,
    };
  }

  const electiveGroup =
    typeof raw.electiveGroup === "string" ? raw.electiveGroup.trim() : "";
  if (electiveGroup.length > MAX_ELECTIVE_GROUP_CODE_LENGTH) {
    return {
      ok: false,
      message: `Subject ${subjectCode}: elective group name cannot exceed ${MAX_ELECTIVE_GROUP_CODE_LENGTH} characters.`,
    };
  }

  // The rule belongs to the GROUP, so it is only meaningful on a group member.
  // Omitting it on a member defaults to ANY_ONE (the only rule in the controlled
  // set); setting it on a compulsory subject is rejected as a contradiction.
  let selectionRule: ElectiveSelectionRule | null = null;
  const rawRule = raw.selectionRule;
  if (electiveGroup) {
    if (rawRule === undefined || rawRule === null || rawRule === "") {
      selectionRule = "ANY_ONE";
    } else if (!isElectiveSelectionRule(rawRule)) {
      return {
        ok: false,
        message: `Subject ${subjectCode}: selection rule must be one of ${ELECTIVE_SELECTION_RULES.join(", ")}.`,
      };
    } else {
      selectionRule = rawRule;
    }
  } else if (rawRule !== undefined && rawRule !== null && rawRule !== "") {
    return {
      ok: false,
      message: `Subject ${subjectCode}: a selection rule can only be set when the subject belongs to an elective group.`,
    };
  }

  return {
    ok: true,
    data: {
      subjectCode,
      subjectName,
      credits,
      subjectType: raw.subjectType,
      category,
      status,
      electiveGroup,
      selectionRule,
      assessment: assessment.data,
    },
  };
}

/**
 * First subject code that appears twice in ONE semester (case-insensitive), or
 * null when the semester has no duplicate. Subject codes must be unique inside
 * their semester — never globally, because the same code (e.g. "CS401") may
 * legitimately exist in another programme, session or semester.
 */
export function findDuplicateSubjectCode(
  subjects: { subjectCode: string }[]
): string | null {
  const seen = new Set<string>();
  for (const subject of subjects) {
    const key = subject.subjectCode.trim().toUpperCase();
    if (seen.has(key)) return subject.subjectCode;
    seen.add(key);
  }
  return null;
}

/**
 * Validate ONE semester. `semesterNumber` is the numeric identity (1–12, the
 * range the existing Syllabus module already uses); `semesterName` is only a
 * display label and may be empty. Subjects may be empty while a curriculum is
 * being built up — and a semester may mix compulsory subjects with elective
 * groups, because group membership is a property of the subject.
 */
export function parseSemesterInput(value: unknown): ValidationResult<SemesterInput> {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Semester is required." };
  }

  const raw = value as Record<string, unknown>;

  const semesterNumber = parseSemesterNumber(raw.semesterNumber);
  if (semesterNumber === null) {
    return {
      ok: false,
      message: `Semester number must be a whole number between 1 and ${MAX_SEMESTERS_PER_STRUCTURE}.`,
    };
  }

  const semesterName =
    typeof raw.semesterName === "string" ? raw.semesterName.trim() : "";
  if (semesterName.length > MAX_SEMESTER_NAME_LENGTH) {
    return {
      ok: false,
      message: `Semester ${semesterNumber}: name cannot exceed ${MAX_SEMESTER_NAME_LENGTH} characters.`,
    };
  }

  const status = raw.status === undefined ? "ACTIVE" : raw.status;
  if (!isStructureStatus(status)) {
    return {
      ok: false,
      message: `Semester ${semesterNumber}: status must be one of ${STRUCTURE_STATUSES.join(", ")}.`,
    };
  }

  const subjects: SubjectInput[] = [];
  if (raw.subjects !== undefined) {
    if (!Array.isArray(raw.subjects)) {
      return {
        ok: false,
        message: `Semester ${semesterNumber}: subjects must be a list.`,
      };
    }
    if (raw.subjects.length > MAX_SUBJECTS_PER_SEMESTER) {
      return {
        ok: false,
        message: `Semester ${semesterNumber}: a semester cannot have more than ${MAX_SUBJECTS_PER_SEMESTER} subjects.`,
      };
    }

    for (let i = 0; i < raw.subjects.length; i++) {
      const parsed = parseSubjectInput(raw.subjects[i]);
      if (!parsed.ok) {
        return { ok: false, message: `Semester ${semesterNumber}: ${parsed.message}` };
      }
      subjects.push(parsed.data);
    }

    const duplicate = findDuplicateSubjectCode(subjects);
    if (duplicate) {
      return {
        ok: false,
        message: `Semester ${semesterNumber}: subject code ${duplicate} appears more than once.`,
      };
    }

    // Every member of an elective group must agree on how the group is chosen,
    // otherwise "which subjects may this student take?" has no single answer.
    const groupRules = new Map<string, ElectiveSelectionRule | null>();
    for (const subject of subjects) {
      if (!subject.electiveGroup) continue;

      const key = subject.electiveGroup.toUpperCase();
      const seenRule = groupRules.get(key);

      if (seenRule !== undefined && seenRule !== subject.selectionRule) {
        return {
          ok: false,
          message: `Semester ${semesterNumber}: elective group ${subject.electiveGroup} mixes selection rules.`,
        };
      }

      groupRules.set(key, subject.selectionRule);
    }
  }

  return {
    ok: true,
    data: { semesterNumber, semesterName, status, subjects },
  };
}

/**
 * Validate a whole semester list: at most 12 semesters, each internally valid,
 * unique semester numbers, and no order requirement (the caller sorts).
 */
export function parseSemesterList(value: unknown): ValidationResult<SemesterInput[]> {
  if (value === undefined || value === null) {
    return { ok: true, data: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, message: "Semesters must be a list." };
  }

  if (value.length > MAX_SEMESTERS_PER_STRUCTURE) {
    return {
      ok: false,
      message: `A programme structure cannot have more than ${MAX_SEMESTERS_PER_STRUCTURE} semesters.`,
    };
  }

  const semesters: SemesterInput[] = [];
  const seen = new Set<number>();

  for (const entry of value) {
    const parsed = parseSemesterInput(entry);
    if (!parsed.ok) return { ok: false, message: parsed.message };

    if (seen.has(parsed.data.semesterNumber)) {
      return {
        ok: false,
        message: `Semester ${parsed.data.semesterNumber} is defined more than once.`,
      };
    }

    seen.add(parsed.data.semesterNumber);
    semesters.push(parsed.data);
  }

  return { ok: true, data: semesters };
}

/* ── Programme structure identity ──────────────────────────────── */

/**
 * Validate the identity + metadata of a programme structure.
 *
 * `programmeCode` is normalised through the SAME parser the Syllabus module uses
 * (parseProgrammeCode), so a programme identifier means exactly the same thing
 * in both modules. `academicSession` is the second half of the key:
 * programmeCode + academicSession identifies one curriculum.
 */
export function parseProgrammeStructureFields(
  value: unknown
): ValidationResult<ProgrammeStructureFields> {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Programme structure details are required." };
  }

  const raw = value as Record<string, unknown>;

  const programmeCode = parseProgrammeCode(raw.programmeCode);
  if (!programmeCode) {
    return {
      ok: false,
      message:
        "Programme code is required (1-20 characters: letters, spaces, dots, ampersands or hyphens).",
    };
  }

  const programmeName =
    typeof raw.programmeName === "string" ? raw.programmeName.trim() : "";
  if (!programmeName) {
    return { ok: false, message: "Programme name is required." };
  }
  if (programmeName.length > MAX_PROGRAMME_NAME_LENGTH) {
    return {
      ok: false,
      message: `Programme name cannot exceed ${MAX_PROGRAMME_NAME_LENGTH} characters.`,
    };
  }

  const academicSession = parseAcademicSession(raw.academicSession);
  if (!academicSession) {
    return {
      ok: false,
      message: "Academic session is required, in the form 2025-26.",
    };
  }

  const status = raw.status === undefined ? "ACTIVE" : raw.status;
  if (!isStructureStatus(status)) {
    return {
      ok: false,
      message: `Status must be one of ${STRUCTURE_STATUSES.join(", ")}.`,
    };
  }

  return {
    ok: true,
    data: { programmeCode, programmeName, academicSession, status },
  };
}

/* ── Safe deletion ─────────────────────────────────────────────── */

/**
 * Decide whether a programme structure may be PERMANENTLY deleted.
 *
 * Curriculum is master data that Syllabus and Result will reference. Permanent
 * deletion is therefore the last resort:
 *
 *   ACTIVE → refused: deactivate first, so an in-use curriculum can never be
 *            destroyed by a single accidental request.
 *   INACTIVE → allowed, only with the caller's explicit confirmation.
 *
 * Deletion never cascades: no Result, Syllabus or other downstream record is
 * ever removed with the structure (those integrations do not exist yet in this
 * phase, and when they do they must be handled deliberately, not implicitly).
 */
export function resolveStructureDeleteDecision(
  status: ProgrammeStructureStatus
): { allowed: boolean; message: string } {
  if (status === "ACTIVE") {
    return {
      allowed: false,
      message:
        "This programme structure is ACTIVE. Deactivate it first, then delete it permanently if you are sure it is no longer needed.",
    };
  }

  return {
    allowed: true,
    message:
      "Permanent deletion of a programme structure is destructive and cannot be undone. Existing Result and Syllabus records are NOT deleted.",
  };
}
