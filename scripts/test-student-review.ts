/**
 * Focused verification of the Phase 4 student application-review domain.
 *
 * Runs entirely in memory: no MongoDB connection, no environment value and no
 * document written. It exercises:
 *   - the pure rules in lib/student-review.ts (statuses, transitions,
 *     structured correction validation, rejection, verification checks,
 *     history builders), and
 *   - the Student model schema + toReviewStudent() via validateSync()/hydrate().
 *
 * The live review API (over HTTP, with a real database) is intentionally not
 * exercised here to avoid uncontrolled production writes — it follows the same
 * temporary-record convention as scripts/test-student-management-db.ts.
 *
 * Usage: npx tsx scripts/test-student-review.ts
 */
import Student, { toReviewStudent, type IStudent } from "@/models/Student";
import {
  APPLICATION_STATUSES,
  CORRECTION_FIELDS,
  LEGACY_APPLICATION_STATUS,
  MAX_ADDITIONAL_INSTRUCTIONS_LENGTH,
  MAX_FIELD_NOTE_LENGTH,
  MAX_REJECTION_REASON_LENGTH,
  REVIEW_ACTIONS,
  accountStatusForStudentStatus,
  buildCorrectionMessage,
  buildCorrectionRequestRecord,
  buildReviewHistoryRecord,
  effectiveApplicationStatus,
  isReviewActionAllowed,
  parseApplicationStatus,
  parseCorrectionRequest,
  parseRejectionReason,
  approvalAccountActivation,
  parseReviewAction,
  targetStatusFor,
  validateRegistrationForVerification,
} from "@/lib/student-review";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

/** A complete registration payload (no status/review fields). */
const base = {
  name: "Aarav Sharma",
  email: "aarav@example.com",
  username: "aarav",
  password: "password123",
  course: "B.Sc Computer Science",
  aadhar: "123456789012",
  abcId: "ABC123456789",
  phone: "9876543210",
  college: "NIT Delhi",
  gender: "Male",
  fatherName: "Rajesh Sharma",
  motherName: "Sunita Sharma",
  admissionYear: 2026,
};

function make(overrides: Record<string, unknown> = {}) {
  return new Student({ ...base, ...overrides });
}

function loaded(overrides: Record<string, unknown> = {}) {
  return Student.hydrate({ ...base, ...overrides });
}

/* ── 1. Status parsing & legacy compatibility ──────────────────────────── */

section("1. Status parsing and legacy compatibility");
check("pending parses", parseApplicationStatus("pending") === "pending");
check(
  "case/whitespace normalises",
  parseApplicationStatus("  NEEDS_Correction ") === "needs_correction"
);
check("an unknown status is null", parseApplicationStatus("approved") === null);
check("a non-string is null", parseApplicationStatus(1) === null);
check(
  "a missing stored status reads as the legacy value (verified)",
  effectiveApplicationStatus(undefined) === LEGACY_APPLICATION_STATUS &&
    effectiveApplicationStatus(null) === "verified"
);
check("a stored status is returned as-is", effectiveApplicationStatus("rejected") === "rejected");
check("the controlled set is exactly five values", APPLICATION_STATUSES.length === 5);

/* ── 2. Review actions & permitted transitions ─────────────────────────── */

section("2. Permitted transitions");
check("parseReviewAction accepts request_correction", parseReviewAction("request_correction") === "request_correction");
check("parseReviewAction accepts reject", parseReviewAction("reject") === "reject");
check("parseReviewAction accepts verify", parseReviewAction("verify") === "verify");
check("parseReviewAction rejects an unknown action", parseReviewAction("enroll") === null);
check("parseReviewAction rejects a non-string", parseReviewAction(7) === null);

check("pending -> needs_correction is allowed", isReviewActionAllowed("request_correction", "pending"));
check("pending -> rejected is allowed", isReviewActionAllowed("reject", "pending"));
check("pending -> verified is allowed", isReviewActionAllowed("verify", "pending"));
check("a legacy (missing status) record cannot be reviewed", !isReviewActionAllowed("verify", undefined));
check("needs_correction cannot be verified directly", !isReviewActionAllowed("verify", "needs_correction"));
check("needs_correction cannot be rejected directly", !isReviewActionAllowed("reject", "needs_correction"));
check("a rejected application cannot be reviewed again", !isReviewActionAllowed("reject", "rejected"));
check("a verified application cannot be verified again", !isReviewActionAllowed("verify", "verified"));

check(
  "no review action ever targets enrolled (Phase 5 excluded)",
  REVIEW_ACTIONS.every((action) => targetStatusFor(action) !== "enrolled")
);
check(
  "no review action targets a Phase 5 state",
  REVIEW_ACTIONS.every((action) =>
    ["needs_correction", "rejected", "verified"].includes(targetStatusFor(action))
  )
);

/* ── 3. Structured correction requests ─────────────────────────────────── */

section("3. Structured correction requests");
const multi = parseCorrectionRequest({
  action: "request_correction",
  fields: [
    { field: "name", note: "Spelling differs from Aadhar" },
    { field: "phone" },
    { field: "admissionYear", note: "  Wrong year  " },
  ],
  additionalInstructions: "  Also confirm the college name.  ",
});
check("multiple selected fields are accepted", multi.ok === true);
if (multi.ok) {
  check("all selected fields are kept", multi.value.fields.length === 3);
  check("field-specific notes are kept", multi.value.fields[0].note === "Spelling differs from Aadhar");
  check("a field without a note keeps no note", multi.value.fields[1].note === undefined);
  check("field notes are trimmed", multi.value.fields[2].note === "Wrong year");
  check(
    "additional instructions are trimmed",
    multi.value.additionalInstructions === "Also confirm the college name."
  );
}

const fieldsOnly = parseCorrectionRequest({ fields: [{ field: "course" }] });
check("selected fields without notes are accepted", fieldsOnly.ok === true);

const instructionsOnly = parseCorrectionRequest({
  additionalInstructions: "Please upload a clearer photo.",
});
check("additional instructions only are accepted", instructionsOnly.ok === true);
if (instructionsOnly.ok) {
  check("instructions-only carries no fields", instructionsOnly.value.fields.length === 0);
}

const empty = parseCorrectionRequest({ fields: [], additionalInstructions: "   " });
check("an empty correction request is rejected", empty.ok === false);

check("a missing body is rejected", parseCorrectionRequest(null).ok === false);
check("a non-object body is rejected", parseCorrectionRequest("nope").ok === false);
check("a non-array fields value is rejected", parseCorrectionRequest({ fields: "name" }).ok === false);
check(
  "an invalid (non-allowlisted) field name is rejected",
  parseCorrectionRequest({ fields: [{ field: "password" }] }).ok === false
);
check(
  "an arbitrary client field name is rejected",
  parseCorrectionRequest({ fields: [{ field: "applicationStatus" }] }).ok === false
);
check(
  "a duplicate field is rejected",
  parseCorrectionRequest({ fields: [{ field: "name" }, { field: "name" }] }).ok === false
);
check(
  "a non-string note is rejected",
  parseCorrectionRequest({ fields: [{ field: "name", note: 5 }] }).ok === false
);
check(
  "an excessively long field note is rejected",
  parseCorrectionRequest({
    fields: [{ field: "name", note: "x".repeat(MAX_FIELD_NOTE_LENGTH + 1) }],
  }).ok === false
);
check(
  "an excessively long additional instruction is rejected",
  parseCorrectionRequest({
    additionalInstructions: "x".repeat(MAX_ADDITIONAL_INSTRUCTIONS_LENGTH + 1),
  }).ok === false
);
check(
  "every allowlisted field is accepted",
  CORRECTION_FIELDS.every(
    (field) => parseCorrectionRequest({ fields: [{ field }] }).ok === true
  )
);

// Mass assignment: extra client keys (status/reviewer/audit) are ignored.
const massAssign = parseCorrectionRequest({
  fields: [{ field: "name", note: "fix" }],
  applicationStatus: "verified",
  verifiedBy: "hacker",
  reviewHistory: [{ action: "verify" }],
  accountStatus: "active",
});
check("extra client keys are ignored (no mass assignment)", massAssign.ok === true);
if (massAssign.ok) {
  const value = massAssign.value as unknown as Record<string, unknown>;
  check("applicationStatus is not copied from the client", value.applicationStatus === undefined);
  check("verifiedBy is not copied from the client", value.verifiedBy === undefined);
  check("reviewHistory is not copied from the client", value.reviewHistory === undefined);
}

/* ── 4. Legacy plain-text correction message ───────────────────────────── */

section("4. Plain-text correction message (legacy compatibility)");
const message = buildCorrectionMessage({
  fields: [
    { field: "name", note: "Spelling" },
    { field: "phone" },
  ],
  additionalInstructions: "Contact the office.",
});
check("the message names the selected fields", message.includes("Student name") && message.includes("Phone number"));
check("the message includes the field note", message.includes("Spelling"));
check("the message includes the additional instructions", message.includes("Contact the office."));
check(
  "the message is capped in length",
  buildCorrectionMessage({
    fields: [],
    additionalInstructions: "x".repeat(5000),
  }).length <= 5000
);

/* ── 5. Rejection ──────────────────────────────────────────────────────── */

section("5. Rejection validation");
const validReject = parseRejectionReason({ reason: "  Documents could not be verified.  " });
check("a valid rejection reason is accepted and trimmed", validReject.ok && validReject.value === "Documents could not be verified.");
check("a whitespace-only reason is rejected", parseRejectionReason({ reason: "   " }).ok === false);
check("an empty reason is rejected", parseRejectionReason({ reason: "" }).ok === false);
check("a missing reason is rejected", parseRejectionReason({}).ok === false);
check("a non-string reason is rejected", parseRejectionReason({ reason: 12 }).ok === false);
check(
  "an excessively long reason is rejected",
  parseRejectionReason({ reason: "x".repeat(MAX_REJECTION_REASON_LENGTH + 1) }).ok === false
);

/* ── 6. Verification required-field validation ─────────────────────────── */

section("6. Verification validation");
check("a complete registration is verifiable", validateRegistrationForVerification(base).length === 0);
check(
  "a missing name is reported",
  validateRegistrationForVerification({ ...base, name: "" }).length > 0
);
check(
  "an invalid email is reported",
  validateRegistrationForVerification({ ...base, email: "not-an-email" }).length > 0
);
check(
  "an invalid phone is reported",
  validateRegistrationForVerification({ ...base, phone: "123" }).length > 0
);
check(
  "an invalid Aadhar is reported",
  validateRegistrationForVerification({ ...base, aadhar: "123" }).length > 0
);
check(
  "an invalid ABC ID is reported",
  validateRegistrationForVerification({ ...base, abcId: "short" }).length > 0
);
check(
  "a missing course is reported",
  validateRegistrationForVerification({ ...base, course: "" }).length > 0
);
check(
  "a missing college is reported",
  validateRegistrationForVerification({ ...base, college: "" }).length > 0
);
check(
  "an invalid gender (when present) is reported",
  validateRegistrationForVerification({ ...base, gender: "Unknown" }).length > 0
);
check(
  "an invalid admission year (when present) is reported",
  validateRegistrationForVerification({ ...base, admissionYear: 1901 }).length > 0
);
check(
  "optional Phase 1 fields may be absent for legacy-shaped records",
  validateRegistrationForVerification({
    name: base.name,
    email: base.email,
    course: base.course,
    aadhar: base.aadhar,
    abcId: base.abcId,
    phone: base.phone,
    college: base.college,
  }).length === 0
);

/* ── 7. History builders use server identity ───────────────────────────── */

section("7. Review history builders");
const at = new Date("2026-10-06T10:00:00.000Z");
const history = buildReviewHistoryRecord({
  action: "reject",
  fromStatus: "pending",
  toStatus: "rejected",
  reason: "Incomplete documents",
  fields: [],
  additionalInstructions: "",
  actorId: "admin-1",
  actorRole: "admin",
  at,
});
check("the history entry keeps the server actor id", history.actorId === "admin-1");
check("the history entry keeps the server actor role", history.actorRole === "admin");
check("the history entry keeps the server timestamp", history.at.getTime() === at.getTime());
check("the history entry keeps the rejection reason", history.reason === "Incomplete documents");

const correctionRecord = buildCorrectionRequestRecord({
  correction: { fields: [{ field: "name", note: "fix" }], additionalInstructions: "" },
  actorId: "admin-2",
  actorRole: "super_admin",
  at,
});
check("the correction record keeps the server actor id", correctionRecord.requestedById === "admin-2");
check("the correction record keeps the server actor role", correctionRecord.requestedByRole === "super_admin");
check("the correction record keeps the server timestamp", correctionRecord.requestedAt.getTime() === at.getTime());

/* ── 8. Student model: schema, defaults, safe review view ──────────────── */

section("8. Student model and safe review view");
const fresh = make();
check("a brand-new student has no applicationStatus default", fresh.applicationStatus === undefined);
check("a hydrated legacy document injects no status", loaded().applicationStatus === undefined);
check("a valid review document passes validation", make({
  applicationStatus: "needs_correction",
  correctionMessage: "Fix your name",
  correctionRequest: {
    fields: [{ field: "name", note: "Spelling" }],
    additionalInstructions: "",
    requestedAt: at,
    requestedById: "admin-1",
    requestedByRole: "admin",
  },
  reviewHistory: [history],
}).validateSync() === undefined);
check(
  "an unknown application status is rejected by the schema",
  Boolean(make({ applicationStatus: "approved" }).validateSync())
);
check(
  "an unknown correction field is rejected by the schema",
  Boolean(
    make({
      correctionRequest: { fields: [{ field: "password" }] },
    }).validateSync()
  )
);

const legacyView = toReviewStudent(loaded() as unknown as IStudent);
check("a legacy student reads as verified", legacyView.applicationStatus === "verified");
check("a legacy student reads as active", legacyView.accountStatus === "active");
check("a legacy student has no correction request", legacyView.correctionRequest === null);
check("a legacy student has an empty review history", legacyView.reviewHistory.length === 0);
check("the safe review view never exposes the password", !("password" in legacyView));

const reviewedView = toReviewStudent(
  loaded({
    applicationStatus: "needs_correction",
    accountStatus: "pending",
    rejectionReason: "x",
    correctionMessage: "Fix your name",
    correctionRequest: {
      fields: [{ field: "name", note: "Spelling" }],
      additionalInstructions: "Also check phone",
      requestedAt: at,
      requestedById: "admin-1",
      requestedByRole: "admin",
    },
    reviewHistory: [history],
  }) as unknown as IStudent
);
check("the safe view surfaces the correction request", reviewedView.correctionRequest?.fields[0].field === "name");
check("the safe view surfaces the review history", reviewedView.reviewHistory.length === 1);
check("the safe view surfaces the legacy plain-text message", reviewedView.correctionMessage === "Fix your name");
check("the safe view surfaces the rejection reason", reviewedView.rejectionReason === "x");

// Phase 5 identifiers are read-only and must round-trip unchanged.
const identifierView = toReviewStudent(
  loaded({
    enrollmentNumber: "EN123456789",
    universityRollNumber: "MSU20260001",
  }) as unknown as IStudent
);
check("enrollment identifiers are preserved, never altered", identifierView.enrollmentNumber === "EN123456789");
check("university roll identifiers are preserved, never altered", identifierView.universityRollNumber === "MSU20260001");

/* ── Approval activates an unactivated account (Phase 3 consistency) ──── */

section("Approval activates a pending account and preserves restrictions");
check(
  "a pending account is activated by approval",
  approvalAccountActivation("pending")?.accountStatus === "active"
);
check(
  "a record with no stored account status is activated by approval",
  approvalAccountActivation(undefined)?.accountStatus === "active" &&
    approvalAccountActivation(null)?.accountStatus === "active"
);
check(
  "an already active account is left alone",
  approvalAccountActivation("active") === null
);
check(
  "a LOCKED account is never activated by an approval",
  approvalAccountActivation("locked") === null
);
check(
  "an INACTIVE (deactivated) account is never activated by an approval",
  approvalAccountActivation("inactive") === null
);
check(
  "an unrecognised stored value is never overwritten",
  approvalAccountActivation("SUSPENDED") === null
);

/* Deactivate/Activate must move the CANONICAL account-access state that the
 * public portal enforces, not only the admin management field. */
check(
  "deactivating maps to the canonical inactive account status",
  accountStatusForStudentStatus("INACTIVE") === "inactive"
);
check(
  "activating maps to the canonical active account status",
  accountStatusForStudentStatus("ACTIVE") === "active"
);
check(
  "the management status and the canonical account status coexist on one record",
  make({ status: "INACTIVE", accountStatus: "inactive" }).validateSync() ===
    undefined &&
    make({ status: "ACTIVE", accountStatus: "active" }).validateSync() === undefined
);

/* ── Summary ───────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
