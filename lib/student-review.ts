/**
 * Phase 4 — student application review domain.
 *
 * PURE module: no DB, no HTTP, no environment access. Shared by the review API
 * route, the admin UI (types/labels only) and the offline tests, so the rules
 * the API enforces are exactly the ones the tests verify.
 *
 * The status field names mirror the shared `students` collection contract that
 * the public MSU app already uses:
 *   applicationStatus: pending | needs_correction | verified | rejected | enrolled
 *   accountStatus:     pending | active | locked | inactive
 *
 * Legacy documents (fields absent) are intentionally treated as
 * verified + active and are never forced through the review workflow.
 *
 * Phase 5 (enrollment, enrollment number, university roll number) is NOT part
 * of this module and must not be implemented here.
 */

import {
  isValidAbcId,
  isValidAadhar,
  isValidEmail,
  isValidPhone,
  type StudentStatus,
} from "@/lib/validation";

/* ── Application / account status ───────────────────────────────────────── */

export const APPLICATION_STATUSES = [
  "pending",
  "needs_correction",
  "verified",
  "rejected",
  "enrolled",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const ACCOUNT_STATUSES = [
  "pending",
  "active",
  "locked",
  "inactive",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** A missing stored status means the pre-review legacy behaviour. */
export const LEGACY_APPLICATION_STATUS: ApplicationStatus = "verified";
export const LEGACY_ACCOUNT_STATUS: AccountStatus = "active";

export function parseApplicationStatus(
  value: unknown
): ApplicationStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (APPLICATION_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as ApplicationStatus)
    : null;
}

export function parseAccountStatus(value: unknown): AccountStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (ACCOUNT_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as AccountStatus)
    : null;
}

/**
 * The effective application status of a record: the stored value when valid,
 * otherwise the legacy default (verified). Used for display and for deciding
 * whether a review transition is allowed.
 */
export function effectiveApplicationStatus(stored: unknown): ApplicationStatus {
  return parseApplicationStatus(stored) ?? LEGACY_APPLICATION_STATUS;
}

/**
 * The account-status change applied when an application is APPROVED (verified
 * or enrolled).
 *
 * A newly registered student is `accountStatus: "pending"` — the account has
 * not been activated yet — so approval must activate it, otherwise the public
 * portal keeps refusing access to a student the admin just approved.
 *
 * An explicit restriction is NEVER lifted: `locked` and `inactive` (and an
 * already `active` account, which needs no change) are returned as `null`, so
 * approving an application can never un-restrict an account.
 */
export function approvalAccountActivation(
  current: unknown
): { accountStatus: AccountStatus } | null {
  // No stored value (or an explicit null) is the "not activated yet" state.
  if (current === undefined || current === null) {
    return { accountStatus: "active" };
  }
  const parsed = parseAccountStatus(current);
  // An unrecognised stored value is never guessed at or overwritten.
  if (parsed === null) return null;
  return parsed === "pending" ? { accountStatus: "active" } : null;
}

/**
 * The canonical account-access state a student-management status maps to.
 *
 * `status` (ACTIVE/INACTIVE) is the admin app's own management field — it drives
 * the list badge and the status filter. Access is NOT decided by it: the public
 * portal's resolvePortalAccess() decides from the shared `students` contract's
 * `accountStatus`. Activating/deactivating a student must therefore move
 * `accountStatus` too (active / inactive), or the portal would keep serving a
 * student the admin has deactivated.
 */
export function accountStatusForStudentStatus(
  status: StudentStatus
): AccountStatus {
  return status === "INACTIVE" ? "inactive" : "active";
}

/* ── Review actions & permitted transitions ─────────────────────────────── */

export const REVIEW_ACTIONS = ["request_correction", "reject", "verify"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

interface TransitionRule {
  /** The only application status an admin may act from. */
  from: ApplicationStatus;
  to: ApplicationStatus;
}

/**
 * Phase 4 transitions owned by an admin reviewer. `needs_correction -> pending`
 * is NOT here on purpose — it happens only through a valid student
 * resubmission in the public app, and must never be triggered from the admin.
 */
const REVIEW_TRANSITIONS: Record<ReviewAction, TransitionRule> = {
  request_correction: { from: "pending", to: "needs_correction" },
  reject: { from: "pending", to: "rejected" },
  verify: { from: "pending", to: "verified" },
};

export const REVIEW_ACTION_LABELS: Record<ReviewAction, string> = {
  request_correction: "Request correction",
  reject: "Reject",
  verify: "Verify",
};

export function parseReviewAction(value: unknown): ReviewAction | null {
  if (typeof value !== "string") return null;
  return (REVIEW_ACTIONS as readonly string[]).includes(value)
    ? (value as ReviewAction)
    : null;
}

export function targetStatusFor(action: ReviewAction): ApplicationStatus {
  return REVIEW_TRANSITIONS[action].to;
}

/** True only when the stored record is in the exact status the action allows. */
export function isReviewActionAllowed(
  action: ReviewAction,
  storedStatus: unknown
): boolean {
  return REVIEW_TRANSITIONS[action].from === effectiveApplicationStatus(storedStatus);
}

/* ── Structured correction requests ────────────────────────────────────── */

/**
 * The student registration fields a reviewer may request a correction for.
 * These are the actual registration/personal fields — the immutable identity
 * fields (email, aadhar, abcId) are deliberately excluded because the public
 * workflow treats them as permanent. `email` is never correctable here.
 */
export const CORRECTION_FIELDS = [
  "name",
  "fatherName",
  "motherName",
  "gender",
  "admissionYear",
  "course",
  "college",
  "phone",
] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];

export const CORRECTION_FIELD_LABELS: Record<CorrectionField, string> = {
  name: "Student name",
  fatherName: "Father's name",
  motherName: "Mother's name",
  gender: "Gender",
  admissionYear: "Admission year",
  course: "Course",
  college: "College name",
  phone: "Phone number",
};

export const MAX_FIELD_NOTE_LENGTH = 300;
export const MAX_ADDITIONAL_INSTRUCTIONS_LENGTH = 1000;
export const MAX_REJECTION_REASON_LENGTH = 500;
export const MAX_CORRECTION_MESSAGE_LENGTH = 2000;

export interface CorrectionFieldEntry {
  field: CorrectionField;
  note?: string;
}

export interface ParsedCorrectionRequest {
  fields: CorrectionFieldEntry[];
  additionalInstructions: string;
}

export interface CorrectionRequestRecord {
  fields: CorrectionFieldEntry[];
  additionalInstructions: string;
  requestedAt: Date;
  /** Server-derived reviewer identity — never taken from the client. */
  requestedById: string;
  requestedByRole: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Validate and normalise a structured correction request from an untrusted
 * body. Only `fields` and `additionalInstructions` are read; every other key
 * is ignored (no mass assignment). Field names are checked against the
 * server-side allowlist — arbitrary client field names can never be stored.
 */
export function parseCorrectionRequest(
  body: unknown
): ParseResult<ParsedCorrectionRequest> {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Correction request must be a JSON object." };
  }
  const record = body as Record<string, unknown>;

  const fields: CorrectionFieldEntry[] = [];
  const rawFields = record.fields;

  if (rawFields !== undefined && rawFields !== null) {
    if (!Array.isArray(rawFields)) {
      return { ok: false, message: "Selected fields must be a list." };
    }
    if (rawFields.length > CORRECTION_FIELDS.length) {
      return {
        ok: false,
        message: "Too many fields were selected for one correction request.",
      };
    }

    const seen = new Set<string>();
    for (const rawEntry of rawFields) {
      if (!rawEntry || typeof rawEntry !== "object") {
        return { ok: false, message: "Each selected field must be an object." };
      }
      const entry = rawEntry as Record<string, unknown>;
      const fieldName = typeof entry.field === "string" ? entry.field.trim() : "";

      if (!fieldName) {
        return { ok: false, message: "A selected field is missing its name." };
      }
      if (!(CORRECTION_FIELDS as readonly string[]).includes(fieldName)) {
        return { ok: false, message: `Unknown correction field: "${fieldName}".` };
      }
      if (seen.has(fieldName)) {
        return {
          ok: false,
          message: `Field "${fieldName}" was selected more than once.`,
        };
      }
      seen.add(fieldName);

      let note: string | undefined;
      if (entry.note !== undefined && entry.note !== null) {
        if (typeof entry.note !== "string") {
          return {
            ok: false,
            message: `The note for "${fieldName}" must be text.`,
          };
        }
        const trimmed = entry.note.trim();
        if (trimmed.length > MAX_FIELD_NOTE_LENGTH) {
          return {
            ok: false,
            message: `The note for "${fieldName}" must be at most ${MAX_FIELD_NOTE_LENGTH} characters.`,
          };
        }
        if (trimmed) note = trimmed;
      }

      fields.push(
        note
          ? { field: fieldName as CorrectionField, note }
          : { field: fieldName as CorrectionField }
      );
    }
  }

  let additionalInstructions = "";
  if (
    record.additionalInstructions !== undefined &&
    record.additionalInstructions !== null
  ) {
    if (typeof record.additionalInstructions !== "string") {
      return { ok: false, message: "Additional instructions must be text." };
    }
    additionalInstructions = record.additionalInstructions.trim();
    if (additionalInstructions.length > MAX_ADDITIONAL_INSTRUCTIONS_LENGTH) {
      return {
        ok: false,
        message: `Additional instructions must be at most ${MAX_ADDITIONAL_INSTRUCTIONS_LENGTH} characters.`,
      };
    }
  }

  // A correction request must carry something actionable.
  if (fields.length === 0 && !additionalInstructions) {
    return {
      ok: false,
      message: "Select at least one field or provide additional instructions.",
    };
  }

  return { ok: true, value: { fields, additionalInstructions } };
}

/**
 * A human-readable plain-text summary stored in the legacy `correctionMessage`
 * field, so the existing student portal keeps showing a correction note until
 * it is updated to render the structured request.
 */
export function buildCorrectionMessage(
  correction: ParsedCorrectionRequest
): string {
  const parts: string[] = [];

  if (correction.fields.length > 0) {
    const labels = correction.fields.map(
      (entry) => CORRECTION_FIELD_LABELS[entry.field] ?? entry.field
    );
    parts.push(`Please correct: ${labels.join(", ")}.`);
    for (const entry of correction.fields) {
      if (entry.note) {
        parts.push(`${CORRECTION_FIELD_LABELS[entry.field] ?? entry.field}: ${entry.note}`);
      }
    }
  }

  if (correction.additionalInstructions) {
    parts.push(correction.additionalInstructions);
  }

  const message = parts.join("\n");
  return message.length > MAX_CORRECTION_MESSAGE_LENGTH
    ? message.slice(0, MAX_CORRECTION_MESSAGE_LENGTH)
    : message;
}

/* ── Rejection ──────────────────────────────────────────────────────────── */

/**
 * Validate a rejection reason from an untrusted body. Only `reason` is read.
 */
export function parseRejectionReason(body: unknown): ParseResult<string> {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Rejection request must be a JSON object." };
  }
  const raw = (body as Record<string, unknown>).reason;
  if (typeof raw !== "string") {
    return { ok: false, message: "A rejection reason is required." };
  }
  const reason = raw.trim();
  if (!reason) {
    return { ok: false, message: "A rejection reason is required." };
  }
  if (reason.length > MAX_REJECTION_REASON_LENGTH) {
    return {
      ok: false,
      message: `The rejection reason must be at most ${MAX_REJECTION_REASON_LENGTH} characters.`,
    };
  }
  return { ok: true, value: reason };
}

/* ── Verification ───────────────────────────────────────────────────────── */

export const STUDENT_GENDERS = ["Male", "Female", "Other"] as const;
export type StudentGender = (typeof STUDENT_GENDERS)[number];

export const ADMISSION_YEAR_MIN = 2000;
export function maxAdmissionYear(reference: Date = new Date()): number {
  return reference.getFullYear() + 1;
}

/** Shape validated before an application may be verified. */
export interface VerifiableStudentFields {
  name?: string | null;
  email?: string | null;
  course?: string | null;
  aadhar?: string | null;
  abcId?: string | null;
  phone?: string | null;
  college?: string | null;
  gender?: string | null;
  fatherName?: string | null;
  motherName?: string | null;
  admissionYear?: number | null;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the registration information required to verify an application,
 * reusing the existing validation rules. Returns a list of safe, student-agnostic
 * problems ([] when valid). The optional Phase 1 fields are validated only when
 * present so legacy-shaped records stay compatible.
 */
export function validateRegistrationForVerification(
  student: VerifiableStudentFields
): string[] {
  const problems: string[] = [];

  if (!hasText(student.name)) problems.push("Student name is required.");
  if (!hasText(student.email) || !isValidEmail((student.email ?? "").trim())) {
    problems.push("A valid email address is required.");
  }
  if (!hasText(student.course)) problems.push("Course is required.");
  if (!hasText(student.aadhar) || !isValidAadhar((student.aadhar ?? "").trim())) {
    problems.push("A valid 12-digit Aadhar number is required.");
  }
  if (!hasText(student.abcId) || !isValidAbcId((student.abcId ?? "").trim())) {
    problems.push("A valid 12-character ABC ID is required.");
  }
  if (!hasText(student.phone) || !isValidPhone((student.phone ?? "").trim())) {
    problems.push("A valid 10-digit phone number is required.");
  }
  if (!hasText(student.college)) problems.push("College name is required.");

  if (hasText(student.gender)) {
    const gender = (student.gender ?? "").trim();
    if (!(STUDENT_GENDERS as readonly string[]).includes(gender)) {
      problems.push("Gender must be Male, Female or Other.");
    }
  }

  if (hasText(student.fatherName) && (student.fatherName ?? "").trim().length < 2) {
    problems.push("Father's name is too short.");
  }
  if (hasText(student.motherName) && (student.motherName ?? "").trim().length < 2) {
    problems.push("Mother's name is too short.");
  }

  if (student.admissionYear !== undefined && student.admissionYear !== null) {
    const year =
      typeof student.admissionYear === "number"
        ? student.admissionYear
        : Number(String(student.admissionYear).trim());
    if (
      !Number.isInteger(year) ||
      year < ADMISSION_YEAR_MIN ||
      year > maxAdmissionYear()
    ) {
      problems.push("Admission year is invalid.");
    }
  }

  return problems;
}

/* ── Review history ─────────────────────────────────────────────────────── */

export interface ReviewHistoryRecord {
  action: ReviewAction;
  fromStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  /** Rejection reason (empty for other actions). */
  reason: string;
  /** Correction field entries (empty for reject/verify). */
  fields: CorrectionFieldEntry[];
  /** Additional instructions (empty unless a correction was requested). */
  additionalInstructions: string;
  /** Server-derived reviewer identity. */
  actorId: string;
  actorRole: string;
  at: Date;
}

export function buildCorrectionRequestRecord(input: {
  correction: ParsedCorrectionRequest;
  actorId: string;
  actorRole: string;
  at: Date;
}): CorrectionRequestRecord {
  return {
    fields: input.correction.fields,
    additionalInstructions: input.correction.additionalInstructions,
    requestedAt: input.at,
    requestedById: input.actorId,
    requestedByRole: input.actorRole,
  };
}

export function buildReviewHistoryRecord(
  input: ReviewHistoryRecord
): ReviewHistoryRecord {
  return {
    action: input.action,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    fields: input.fields,
    additionalInstructions: input.additionalInstructions,
    actorId: input.actorId,
    actorRole: input.actorRole,
    at: input.at,
  };
}
