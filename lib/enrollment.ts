/**
 * Phase 5 — secure student enrollment and official identifier rules.
 *
 * PURE module: no DB, no HTTP, no environment access. The enrollment API route,
 * the admin UI (labels only) and the offline tests all use these rules, so the
 * format/eligibility logic the server enforces is exactly what the tests verify.
 *
 * Approved identifier rules:
 *   enrollmentNumber     "EN" + exactly 8 digits, ONE global sequence for the
 *                        whole system, no annual reset, first value EN00000001.
 *   universityRollNumber "MSU" + 4 admission-year digits + exactly 6 digits,
 *                        ONE independent sequence per admission year, first
 *                        value for a year is 000001.
 *
 * Existing valid identifiers are permanent: they are never overwritten,
 * reassigned or derived from one another. A record missing ONE of the two
 * identifiers is repaired by allocating only the missing one; a MALFORMED or
 * contradictory pair is never silently completed and is rejected for manual
 * remediation instead.
 *
 * Identifier VALUES are never accepted from a client — the sequence value comes
 * from the atomic counter allocation in the enrollment route, and only the
 * server formats it here.
 */

import {
  ADMISSION_YEAR_MIN,
  maxAdmissionYear,
  validateRegistrationForVerification,
  type VerifiableStudentFields,
} from "@/lib/student-review";

/* ── Formats ────────────────────────────────────────────────────────────── */

/** Official enrollment number: EN + exactly 8 digits. */
export const ENROLLMENT_NUMBER_PATTERN = /^EN[0-9]{8}$/;
/** Official university roll number: MSU + 4 year digits + exactly 6 digits. */
export const UNIVERSITY_ROLL_NUMBER_PATTERN = /^MSU[0-9]{4}[0-9]{6}$/;

export const ENROLLMENT_NUMBER_PREFIX = "EN";
export const UNIVERSITY_ROLL_NUMBER_PREFIX = "MSU";
export const ENROLLMENT_SEQUENCE_DIGITS = 8;
export const UNIVERSITY_ROLL_YEAR_DIGITS = 4;
export const UNIVERSITY_ROLL_SEQUENCE_DIGITS = 6;

/** Highest enrollment sequence value: EN99999999. */
export const ENROLLMENT_SEQUENCE_MAX = 99_999_999;
/** Highest per-year roll sequence value: MSU<year>999999. */
export const UNIVERSITY_ROLL_SEQUENCE_MAX = 999_999;

/* ── Counter namespaces ─────────────────────────────────────────────────── */

/** One global enrollment sequence — never reset, never scoped by year. */
export const ENROLLMENT_COUNTER_ID = "enrollment";

/** Independent roll sequence namespace for one admission year. */
export function universityRollCounterId(admissionYear: number): string {
  if (!Number.isInteger(admissionYear)) {
    throw new Error("Admission year must be an integer.");
  }
  return `university-roll:${admissionYear}`;
}

/* ── Parsing (server-side / diagnostics only) ───────────────────────────── */

export interface ParsedEnrollmentNumber {
  number: string;
  sequence: number;
}

/**
 * Parse a stored enrollment number. Returns null when the value is not a
 * string in the exact EN######## form (so malformed legacy values are
 * reported rather than interpreted).
 */
export function parseEnrollmentNumber(
  value: unknown
): ParsedEnrollmentNumber | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ENROLLMENT_NUMBER_PATTERN.test(trimmed)) return null;
  return { number: trimmed, sequence: Number(trimmed.slice(2)) };
}

export interface ParsedUniversityRollNumber {
  number: string;
  admissionYear: number;
  sequence: number;
}

/** Parse a stored university roll number; null when malformed. */
export function parseUniversityRollNumber(
  value: unknown
): ParsedUniversityRollNumber | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!UNIVERSITY_ROLL_NUMBER_PATTERN.test(trimmed)) return null;
  return {
    number: trimmed,
    admissionYear: Number(trimmed.slice(3, 7)),
    sequence: Number(trimmed.slice(7)),
  };
}

/* ── Formatting (server-side only) ──────────────────────────────────────── */

/**
 * Format an allocated enrollment sequence value. Returns null when the value
 * is out of range (non-integer, < 1 or > EN99999999) — the caller must then
 * abandon the allocation instead of writing a malformed identifier.
 */
export function formatEnrollmentNumber(sequence: number): string | null {
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence > ENROLLMENT_SEQUENCE_MAX
  ) {
    return null;
  }
  return `${ENROLLMENT_NUMBER_PREFIX}${String(sequence).padStart(
    ENROLLMENT_SEQUENCE_DIGITS,
    "0"
  )}`;
}

/**
 * Format an allocated university roll sequence value for one admission year.
 * Returns null when the year or the sequence value is out of range.
 */
export function formatUniversityRollNumber(
  admissionYear: number,
  sequence: number
): string | null {
  if (
    typeof admissionYear !== "number" ||
    !Number.isInteger(admissionYear) ||
    admissionYear < ADMISSION_YEAR_MIN ||
    admissionYear > 9999
  ) {
    return null;
  }
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence > UNIVERSITY_ROLL_SEQUENCE_MAX
  ) {
    return null;
  }
  return `${UNIVERSITY_ROLL_NUMBER_PREFIX}${String(admissionYear).padStart(
    UNIVERSITY_ROLL_YEAR_DIGITS,
    "0"
  )}${String(sequence).padStart(UNIVERSITY_ROLL_SEQUENCE_DIGITS, "0")}`;
}

/* ── Admission year ─────────────────────────────────────────────────────── */

/**
 * Validate a stored admission year using the rules the review workflow already
 * uses (ADMISSION_YEAR_MIN .. current year + 1). The roll number year is always
 * taken from the validated admission year — never from the calendar year and
 * never guessed.
 */
export function parseAdmissionYear(
  value: unknown,
  reference: Date = new Date()
): number | null {
  let year: number;
  if (typeof value === "number") {
    year = value;
  } else if (typeof value === "string" && /^\d{4}$/.test(value.trim())) {
    year = Number(value.trim());
  } else {
    return null;
  }

  if (
    !Number.isInteger(year) ||
    year < ADMISSION_YEAR_MIN ||
    year > maxAdmissionYear(reference)
  ) {
    return null;
  }
  return year;
}

/* ── Enrollment eligibility ─────────────────────────────────────────────── */

export interface EnrollmentCandidateFields extends VerifiableStudentFields {
  /** Stored application status (NOT the legacy-normalised value). */
  applicationStatus?: string | null;
  enrollmentNumber?: unknown;
  universityRollNumber?: unknown;
}

export type EnrollmentRejectionCode =
  | "not_verified"
  | "legacy_status_missing"
  | "enrolled_missing_identifiers"
  | "conflicting_identifiers"
  | "invalid_registration"
  | "invalid_admission_year";

/** How many official identifiers an operation must GENERATE. */
export type IdentifierAllocation = "none" | "both" | "roll" | "enrollment";

export type EnrollmentDecision =
  | {
      ok: true;
      mode: "enroll";
      /**
       * What must be generated: `both` (nothing issued yet), `roll` (a valid
       * enrollment number exists), or `enrollment` (a valid roll number exists).
       */
      allocate: Exclude<IdentifierAllocation, "none">;
      /** Needed whenever a roll number is allocated; null when only the
       *  enrollment number is missing (the global sequence is year-agnostic). */
      admissionYear: number | null;
    }
  | {
      ok: true;
      mode: "already_enrolled";
      allocate: "none";
      admissionYear: number | null;
      enrollmentNumber: string;
      universityRollNumber: string;
    }
  | {
      ok: false;
      status: 409 | 422;
      code: EnrollmentRejectionCode;
      message: string;
    };

/** "absent" = field missing/null (a normal, non-conflicting state). */
type FieldState = "absent" | "blank" | "value";

function fieldState(value: unknown): FieldState {
  if (value === undefined || value === null) return "absent";
  if (typeof value === "string" && value.trim() === "") return "blank";
  return "value";
}

function humanizeStatus(status: string): string {
  return status
    .split("_")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Plan which official identifiers must be GENERATED for a record, judged purely
 * from the identifiers the record already carries. The application status is
 * deliberately NOT part of this decision — callers (verification, enrollment,
 * the repair script) apply their own status rules on top.
 *
 * Outcomes:
 *   none              both identifiers present and mutually consistent;
 *                     nothing may be allocated (issued values are permanent).
 *   allocate_both     neither identifier is present.
 *   repair_roll       a valid enrollment number exists → allocate ONLY the
 *                     roll number (needs the admission year).
 *   repair_enrollment a valid roll number exists → allocate ONLY the enrollment
 *                     number (the global sequence is year-agnostic).
 *
 * BLANK values ("") count as absent: an empty string is not an issued
 * identifier, so filling it repairs the record without overwriting anything.
 * MALFORMED values are never repaired — they are reported as a conflict so an
 * operator resolves them, and a real value is never replaced.
 */
export type IdentifierPlan =
  | {
      ok: true;
      mode: "none";
      admissionYear: number | null;
      enrollmentNumber: string;
      universityRollNumber: string;
    }
  | { ok: true; mode: "allocate_both"; admissionYear: number }
  | { ok: true; mode: "repair_roll"; admissionYear: number; enrollmentNumber: string }
  | {
      ok: true;
      mode: "repair_enrollment";
      /** Taken from the already-issued roll number (it embeds the year). */
      admissionYear: number;
      universityRollNumber: string;
    }
  | {
      ok: false;
      status: 409 | 422;
      code: EnrollmentRejectionCode;
      message: string;
    };

export function planIdentifierAssignment(
  student: EnrollmentCandidateFields,
  reference: Date = new Date()
): IdentifierPlan {
  const enrollmentField = fieldState(student.enrollmentNumber);
  const rollField = fieldState(student.universityRollNumber);

  const enrollment =
    enrollmentField === "value" ? parseEnrollmentNumber(student.enrollmentNumber) : null;
  const roll =
    rollField === "value" ? parseUniversityRollNumber(student.universityRollNumber) : null;

  const admissionYear = parseAdmissionYear(student.admissionYear, reference);

  /* A present-but-malformed identifier is never repaired or replaced. */
  const malformed: string[] = [];
  if (enrollmentField === "value" && !enrollment) {
    malformed.push("the enrollment number is not in the EN######## format");
  }
  if (rollField === "value" && !roll) {
    malformed.push("the university roll number is not in the MSUYYYY###### format");
  }
  if (malformed.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "conflicting_identifiers",
      message: `This record already carries an official identifier that is not in the approved format (${malformed.join(
        "; "
      )}). Nothing was changed — an issued identifier is never overwritten, so manual remediation is required.`,
    };
  }

  /* Both issued — the only state that allocates nothing. */
  if (enrollment && roll) {
    if (admissionYear !== null && roll.admissionYear !== admissionYear) {
      return {
        ok: false,
        status: 409,
        code: "conflicting_identifiers",
        message: `The university roll number year (${roll.admissionYear}) does not match the admission year (${admissionYear}). Nothing was changed — manual remediation is required.`,
      };
    }
    return {
      ok: true,
      mode: "none",
      admissionYear,
      enrollmentNumber: enrollment.number,
      universityRollNumber: roll.number,
    };
  }

  /* Only a roll number is issued → repair the enrollment number. The roll
   * number already embeds the admission year, so no admission year is needed. */
  if (roll && !enrollment) {
    return {
      ok: true,
      mode: "repair_enrollment",
      admissionYear: roll.admissionYear,
      universityRollNumber: roll.number,
    };
  }

  /* Only an enrollment number is issued → repair the roll number. */
  if (enrollment && !roll) {
    if (admissionYear === null) {
      return {
        ok: false,
        status: 422,
        code: "invalid_admission_year",
        message:
          "A valid admission year is required before the university roll number can be assigned — its year comes from the admission year and is never guessed.",
      };
    }
    return {
      ok: true,
      mode: "repair_roll",
      admissionYear,
      enrollmentNumber: enrollment.number,
    };
  }

  /* Nothing issued (absent or blank) → allocate both. */
  if (admissionYear === null) {
    return {
      ok: false,
      status: 422,
      code: "invalid_admission_year",
      message:
        "A valid admission year is required before official identifiers can be assigned — the university roll number year comes from it and is never guessed.",
    };
  }
  return { ok: true, mode: "allocate_both", admissionYear };
}

/**
 * Decide what enrolling a student means, from the CURRENT database record.
 *
 * Outcomes:
 *  - `enroll`            — eligible: verified (or already enrolled for a
 *                          REPAIR of a single missing identifier), complete
 *                          registration, and the identifiers the record is
 *                          missing can be safely allocated.
 *  - `already_enrolled`  — idempotent success: the record already carries two
 *                          valid, consistent identifiers AND is approved
 *                          (verified or enrolled), so nothing is allocated.
 *  - rejection           — everything else. MALFORMED identifiers and a roll
 *                          year that contradicts the admission year are still
 *                          reported for manual remediation; a single MISSING
 *                          identifier is repaired instead of being refused.
 *
 * A legacy record with no stored applicationStatus is REJECTED even though the
 * read-time compatibility layer reports it as "verified": legacy students are
 * never enrolled automatically.
 */
export function decideEnrollment(
  student: EnrollmentCandidateFields,
  reference: Date = new Date()
): EnrollmentDecision {
  const storedStatus =
    typeof student.applicationStatus === "string"
      ? student.applicationStatus.trim().toLowerCase()
      : "";

  const plan = planIdentifierAssignment(student, reference);
  if (!plan.ok) return plan;

  /* Nothing may be allocated. An already-enrolled record (or one that was
   * approved and fully identified) is an idempotent success — no new number is
   * ever allocated for it. */
  if (plan.mode === "none") {
    if (storedStatus === "enrolled" || storedStatus === "verified") {
      return {
        ok: true,
        mode: "already_enrolled",
        allocate: "none",
        admissionYear: plan.admissionYear,
        enrollmentNumber: plan.enrollmentNumber,
        universityRollNumber: plan.universityRollNumber,
      };
    }

    return {
      ok: false,
      status: 409,
      code: "conflicting_identifiers",
      message: `This record already carries both official identifiers but its application status is ${
        storedStatus ? `"${storedStatus}"` : "missing (legacy document)"
      }. Nothing was changed — an issued identifier is never overwritten, so manual remediation is required.`,
    };
  }

  if (!storedStatus) {
    return {
      ok: false,
      status: 409,
      code: "legacy_status_missing",
      message:
        "This record carries no application status (legacy document). Legacy students are never enrolled automatically — review and verify the application first.",
    };
  }

  /*
   * A record claimed as enrolled with NOTHING assigned is not a one-identifier
   * repair — that inconsistency needs a human decision.
   */
  if (plan.mode === "allocate_both" && storedStatus === "enrolled") {
    return {
      ok: false,
      status: 409,
      code: "enrolled_missing_identifiers",
      message:
        "This student is recorded as enrolled but has no official identifiers. Manual remediation is required before enrollment can run.",
    };
  }

  if (storedStatus !== "verified" && storedStatus !== "enrolled") {
    return {
      ok: false,
      status: 409,
      code: "not_verified",
      message: `This application is currently "${humanizeStatus(
        storedStatus
      )}" and can only receive official identifiers from "Verified". Reload the list and try again.`,
    };
  }

  const registrationProblems = validateRegistrationForVerification(student);
  if (registrationProblems.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_registration",
      message: registrationProblems.join(" "),
    };
  }

  if (plan.mode === "allocate_both") {
    return { ok: true, mode: "enroll", allocate: "both", admissionYear: plan.admissionYear };
  }
  if (plan.mode === "repair_roll") {
    return { ok: true, mode: "enroll", allocate: "roll", admissionYear: plan.admissionYear };
  }
  return { ok: true, mode: "enroll", allocate: "enrollment", admissionYear: null };
}

/** Convenience for read models: may this record be enrolled right now? */
export function isEnrollmentEligible(
  student: EnrollmentCandidateFields,
  reference: Date = new Date()
): boolean {
  const decision = decideEnrollment(student, reference);
  return decision.ok && decision.mode === "enroll";
}

/* ── Legacy-data preflight (dry-run diagnostics) ─────────────────────────── */

export interface EnrollmentScanRecord {
  _id?: unknown;
  applicationStatus?: unknown;
  admissionYear?: unknown;
  enrollmentNumber?: unknown;
  universityRollNumber?: unknown;
}

export interface EnrollmentIdentifierConflictReport {
  totalStudents: number;
  duplicateEnrollmentNumbers: { value: string; studentIds: string[] }[];
  duplicateUniversityRollNumbers: { value: string; studentIds: string[] }[];
  invalidEnrollmentNumbers: { studentId: string; value: string }[];
  invalidUniversityRollNumbers: { studentId: string; value: string }[];
  rollYearMismatches: {
    studentId: string;
    value: string;
    admissionYear: number | null;
  }[];
  partialIdentifiers: {
    studentId: string;
    hasEnrollmentNumber: boolean;
    hasUniversityRollNumber: boolean;
  }[];
  identifiersWithNonEnrolledStatus: {
    studentId: string;
    applicationStatus: string | null;
  }[];
  enrolledWithoutIdentifiers: { studentId: string }[];
  blankIdentifierValues: {
    studentId: string;
    field: "enrollmentNumber" | "universityRollNumber";
  }[];
  missingApplicationStatus: { studentId: string }[];
  invalidAdmissionYears: { studentId: string; admissionYear: unknown }[];
  /** Number of records with at least one reported issue. */
  conflictingRecordCount: number;
  /** Total reported issues (a record may have several). */
  issueCount: number;
}

function scanId(record: EnrollmentScanRecord): string {
  const id = record._id;
  if (id === undefined || id === null) return "(no id)";
  return typeof id === "string" ? id : String(id);
}

/**
 * Read-only scan of stored student records for the legacy-data categories the
 * preflight must report. Never repairs, rewrites or deletes anything, and never
 * returns personal data — only student ids and the identifiers in question.
 */
export function scanIdentifierConflicts(
  students: Iterable<EnrollmentScanRecord>,
  reference: Date = new Date()
): EnrollmentIdentifierConflictReport {
  const report: EnrollmentIdentifierConflictReport = {
    totalStudents: 0,
    duplicateEnrollmentNumbers: [],
    duplicateUniversityRollNumbers: [],
    invalidEnrollmentNumbers: [],
    invalidUniversityRollNumbers: [],
    rollYearMismatches: [],
    partialIdentifiers: [],
    identifiersWithNonEnrolledStatus: [],
    enrolledWithoutIdentifiers: [],
    blankIdentifierValues: [],
    missingApplicationStatus: [],
    invalidAdmissionYears: [],
    conflictingRecordCount: 0,
    issueCount: 0,
  };

  const enrollmentValues = new Map<string, string[]>();
  const rollValues = new Map<string, string[]>();
  const conflicted = new Set<string>();

  function flag(studentId: string) {
    conflicted.add(studentId);
  }

  for (const student of students) {
    report.totalStudents += 1;
    const studentId = scanId(student);

    const rawEnrollment = student.enrollmentNumber;
    const rawRoll = student.universityRollNumber;
    const enrollmentField = fieldState(rawEnrollment);
    const rollField = fieldState(rawRoll);

    const storedStatus =
      typeof student.applicationStatus === "string"
        ? student.applicationStatus.trim().toLowerCase()
        : "";

    if (!storedStatus) {
      report.missingApplicationStatus.push({ studentId });
      flag(studentId);
    }

    const enrollment =
      enrollmentField === "value" ? parseEnrollmentNumber(rawEnrollment) : null;
    const roll = rollField === "value" ? parseUniversityRollNumber(rawRoll) : null;

    if (enrollmentField === "blank") {
      report.blankIdentifierValues.push({ studentId, field: "enrollmentNumber" });
      flag(studentId);
    } else if (enrollmentField === "value" && !enrollment) {
      report.invalidEnrollmentNumbers.push({
        studentId,
        value: String(rawEnrollment),
      });
      flag(studentId);
    } else if (enrollment) {
      const ids = enrollmentValues.get(enrollment.number) ?? [];
      ids.push(studentId);
      enrollmentValues.set(enrollment.number, ids);
    }

    if (rollField === "blank") {
      report.blankIdentifierValues.push({
        studentId,
        field: "universityRollNumber",
      });
      flag(studentId);
    } else if (rollField === "value" && !roll) {
      report.invalidUniversityRollNumbers.push({
        studentId,
        value: String(rawRoll),
      });
      flag(studentId);
    } else if (roll) {
      const ids = rollValues.get(roll.number) ?? [];
      ids.push(studentId);
      rollValues.set(roll.number, ids);
    }

    const admissionsYear = parseAdmissionYear(student.admissionYear, reference);
    if (
      student.admissionYear !== undefined &&
      student.admissionYear !== null &&
      student.admissionYear !== "" &&
      admissionsYear === null
    ) {
      report.invalidAdmissionYears.push({
        studentId,
        admissionYear: student.admissionYear,
      });
      flag(studentId);
    }

    if (roll && admissionsYear !== null && roll.admissionYear !== admissionsYear) {
      report.rollYearMismatches.push({
        studentId,
        value: roll.number,
        admissionYear: admissionsYear,
      });
      flag(studentId);
    }

    const hasEnrollmentNumber = enrollmentField !== "absent";
    const hasUniversityRollNumber = rollField !== "absent";

    if (hasEnrollmentNumber !== hasUniversityRollNumber) {
      report.partialIdentifiers.push({
        studentId,
        hasEnrollmentNumber,
        hasUniversityRollNumber,
      });
      flag(studentId);
    }

    if (
      (hasEnrollmentNumber || hasUniversityRollNumber) &&
      storedStatus !== "enrolled"
    ) {
      report.identifiersWithNonEnrolledStatus.push({
        studentId,
        applicationStatus: storedStatus || null,
      });
      flag(studentId);
    }

    if (storedStatus === "enrolled" && !hasEnrollmentNumber && !hasUniversityRollNumber) {
      report.enrolledWithoutIdentifiers.push({ studentId });
      flag(studentId);
    }
  }

  for (const [value, studentIds] of enrollmentValues) {
    if (studentIds.length > 1) {
      report.duplicateEnrollmentNumbers.push({ value, studentIds });
      studentIds.forEach(flag);
    }
  }
  for (const [value, studentIds] of rollValues) {
    if (studentIds.length > 1) {
      report.duplicateUniversityRollNumbers.push({ value, studentIds });
      studentIds.forEach(flag);
    }
  }

  report.duplicateEnrollmentNumbers.sort((a, b) => a.value.localeCompare(b.value));
  report.duplicateUniversityRollNumbers.sort((a, b) =>
    a.value.localeCompare(b.value)
  );

  report.issueCount =
    report.duplicateEnrollmentNumbers.length +
    report.duplicateUniversityRollNumbers.length +
    report.invalidEnrollmentNumbers.length +
    report.invalidUniversityRollNumbers.length +
    report.rollYearMismatches.length +
    report.partialIdentifiers.length +
    report.identifiersWithNonEnrolledStatus.length +
    report.enrolledWithoutIdentifiers.length +
    report.blankIdentifierValues.length +
    report.missingApplicationStatus.length +
    report.invalidAdmissionYears.length;

  report.conflictingRecordCount = conflicted.size;

  return report;
}

/* ── Index intent (NOT created by this code) ─────────────────────────────── */

export interface EnrollmentIndexIntent {
  name: string;
  key: Record<string, 1>;
  options: {
    unique: true;
    name: string;
    partialFilterExpression: Record<string, { $type: string }>;
  };
  description: string;
}

/**
 * The approved uniqueness intent. These indexes are deliberately NOT declared
 * on the Student schema: Mongoose's automatic index creation (`autoIndex`) runs
 * `createIndexes` when the model initialises, so declaring them would create
 * production indexes on the next app start without approval. They are created
 * only by `scripts/create-enrollment-indexes.ts --apply`, after the dry-run
 * preflight shows no conflicts, and only with explicit authorization.
 */
export const ENROLLMENT_INDEX_INTENT: EnrollmentIndexIntent[] = [
  {
    name: "uniq_enrollment_number_present",
    key: { enrollmentNumber: 1 },
    options: {
      unique: true,
      name: "uniq_enrollment_number_present",
      partialFilterExpression: { enrollmentNumber: { $type: "string" } },
    },
    description:
      "Unique enrollment number for documents where enrollmentNumber is a string (legacy documents without one are not indexed).",
  },
  {
    name: "uniq_university_roll_number_present",
    key: { universityRollNumber: 1 },
    options: {
      unique: true,
      name: "uniq_university_roll_number_present",
      partialFilterExpression: { universityRollNumber: { $type: "string" } },
    },
    description:
      "Unique university roll number for documents where universityRollNumber is a string (the admission year is embedded in the value).",
  },
];
