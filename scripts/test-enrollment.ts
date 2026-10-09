/**
 * Focused verification of the Phase 5 enrollment domain (offline).
 *
 * Runs entirely in memory: no MongoDB connection, no environment value and no
 * document written. It exercises:
 *   - the pure identifier rules in lib/enrollment.ts (formats, parsing,
 *     sequence bounds, admission-year validation, eligibility decisions,
 *     idempotency/conflict decisions, the legacy conflict scanner, index
 *     intent),
 *   - the Counter / EnrollmentEvent schema declarations, and
 *   - the Student read model (toReviewStudent) + its schema declaration guard.
 *
 * Database-level behaviour (transactions, concurrency, rollback, real counter
 * allocation) is NOT covered here — it needs the isolated test database and is
 * implemented in scripts/test-enrollment-db.ts.
 *
 * Usage: npx tsx scripts/test-enrollment.ts
 */
import mongoose from "mongoose";
import Student, { toReviewStudent } from "@/models/Student";
import Counter from "@/models/Counter";
import EnrollmentEvent from "@/models/EnrollmentEvent";
import {
  ADMISSION_YEAR_MIN,
  maxAdmissionYear,
} from "@/lib/student-review";
import {
  ENROLLMENT_COUNTER_ID,
  ENROLLMENT_INDEX_INTENT,
  ENROLLMENT_NUMBER_PATTERN,
  ENROLLMENT_SEQUENCE_MAX,
  UNIVERSITY_ROLL_NUMBER_PATTERN,
  UNIVERSITY_ROLL_SEQUENCE_MAX,
  decideEnrollment,
  formatEnrollmentNumber,
  formatUniversityRollNumber,
  isEnrollmentEligible,
  parseAdmissionYear,
  parseEnrollmentNumber,
  parseUniversityRollNumber,
  planIdentifierAssignment,
  scanIdentifierConflicts,
  universityRollCounterId,
} from "@/lib/enrollment";

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

/* ── Fixtures ───────────────────────────────────────────────────────────── */

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

function candidate(overrides: Record<string, unknown> = {}) {
  return { ...base, ...overrides };
}

/* ── 1. Enrollment number format ────────────────────────────────────────── */

section("1. Enrollment number format and parsing");

check("the pattern is EN + exactly 8 digits", ENROLLMENT_NUMBER_PATTERN.test("EN00000001"));
check("7 digits are rejected by the pattern", !ENROLLMENT_NUMBER_PATTERN.test("EN0000001"));
check("9 digits are rejected by the pattern", !ENROLLMENT_NUMBER_PATTERN.test("EN000000001"));
check("a lowercase prefix is rejected", !ENROLLMENT_NUMBER_PATTERN.test("en00000001"));
check("a different prefix is rejected", !ENROLLMENT_NUMBER_PATTERN.test("MS00000001"));

check("the first global value is EN00000001", formatEnrollmentNumber(1) === "EN00000001");
check("the second global value is EN00000002", formatEnrollmentNumber(2) === "EN00000002");
check("leading zeroes are preserved", formatEnrollmentNumber(42) === "EN00000042");
check(
  "the maximum sequence value is EN99999999",
  formatEnrollmentNumber(ENROLLMENT_SEQUENCE_MAX) === "EN99999999"
);
check("sequence 0 is refused", formatEnrollmentNumber(0) === null);
check("a negative sequence is refused", formatEnrollmentNumber(-1) === null);
check(
  "a sequence above the maximum is refused",
  formatEnrollmentNumber(ENROLLMENT_SEQUENCE_MAX + 1) === null
);
check("a non-integer sequence is refused", formatEnrollmentNumber(1.5) === null);
check(
  "a client-supplied sequence string is refused",
  formatEnrollmentNumber("1" as unknown as number) === null
);
check("NaN is refused", formatEnrollmentNumber(Number.NaN) === null);

check(
  "a formatted value parses back to the same sequence",
  parseEnrollmentNumber("EN00000042")?.sequence === 42
);
check(
  "a formatted value parses back to the same string",
  parseEnrollmentNumber("EN00000042")?.number === "EN00000042"
);
check("a malformed stored value parses to null", parseEnrollmentNumber("EN123") === null);
check("a non-string stored value parses to null", parseEnrollmentNumber(12345678) === null);
check("null parses to null", parseEnrollmentNumber(null) === null);

/* ── 2. University roll number format ───────────────────────────────────── */

section("2. University roll number format and parsing");

check(
  "the pattern is MSU + 4 year digits + 6 sequence digits",
  UNIVERSITY_ROLL_NUMBER_PATTERN.test("MSU2026000001")
);
check("a missing year digit is rejected", !UNIVERSITY_ROLL_NUMBER_PATTERN.test("MSU202600001"));
check(
  "an extra sequence digit is rejected",
  !UNIVERSITY_ROLL_NUMBER_PATTERN.test("MSU20260000001")
);
check("a lowercase value is rejected", !UNIVERSITY_ROLL_NUMBER_PATTERN.test("msu2026000001"));

check(
  "the first value for a year is 000001",
  formatUniversityRollNumber(2026, 1) === "MSU2026000001"
);
check(
  "the next value in the same year increments",
  formatUniversityRollNumber(2026, 2) === "MSU2026000002"
);
check(
  "another year has its own sequence",
  formatUniversityRollNumber(2027, 1) === "MSU2027000001"
);
check(
  "the year is embedded verbatim",
  formatUniversityRollNumber(2030, 7) === "MSU2030000007"
);
check(
  "the maximum per-year sequence is 999999",
  formatUniversityRollNumber(2026, UNIVERSITY_ROLL_SEQUENCE_MAX) === "MSU2026999999"
);
check("sequence 0 is refused", formatUniversityRollNumber(2026, 0) === null);
check(
  "a sequence above the per-year maximum is refused",
  formatUniversityRollNumber(2026, UNIVERSITY_ROLL_SEQUENCE_MAX + 1) === null
);
check("a year below the minimum is refused", formatUniversityRollNumber(1999, 1) === null);
check("a non-integer year is refused", formatUniversityRollNumber(2026.5, 1) === null);
check(
  "a client-supplied sequence string is refused",
  formatUniversityRollNumber(2026, "1" as unknown as number) === null
);

const parsedRoll = parseUniversityRollNumber("MSU2026000042");
check("a roll number parses its year", parsedRoll?.admissionYear === 2026);
check("a roll number parses its sequence", parsedRoll?.sequence === 42);
check(
  "a malformed roll number parses to null",
  parseUniversityRollNumber("MSU26000042") === null
);
check(
  "a roll number with a non-numeric tail parses to null",
  parseUniversityRollNumber("MSU20260000AB") === null
);

/* ── 3. Independent counter namespaces ─────────────────────────────────── */

section("3. Counter namespaces and bounds");

check(
  "the enrollment sequence is one global namespace",
  ENROLLMENT_COUNTER_ID === "enrollment"
);
check(
  "the roll sequence is namespaced per admission year",
  universityRollCounterId(2026) === "university-roll:2026"
);
check(
  "two admission years use different roll namespaces",
  universityRollCounterId(2026) !== universityRollCounterId(2027)
);
check(
  "the roll namespace never equals the enrollment namespace",
  universityRollCounterId(2026) !== ENROLLMENT_COUNTER_ID
);
check(
  "the enrollment namespace is not year-scoped",
  !ENROLLMENT_COUNTER_ID.includes("university-roll")
);
check(
  "a non-integer admission year cannot build a namespace",
  (() => {
    try {
      universityRollCounterId(2026.5);
      return false;
    } catch {
      return true;
    }
  })()
);
check(
  "the enrollment sequence cap is 8 digits",
  String(ENROLLMENT_SEQUENCE_MAX).length === 8
);
check(
  "the per-year roll sequence cap is 6 digits",
  String(UNIVERSITY_ROLL_SEQUENCE_MAX).length === 6
);

/* ── 4. Admission year validation ──────────────────────────────────────── */

section("4. Admission year validation");

const reference = new Date("2026-06-01T00:00:00Z");
check("a valid year is accepted", parseAdmissionYear(2026, reference) === 2026);
check("the minimum year is accepted", parseAdmissionYear(ADMISSION_YEAR_MIN, reference) === ADMISSION_YEAR_MIN);
check(
  "next year is accepted (admission cycle)",
  parseAdmissionYear(maxAdmissionYear(reference), reference) === maxAdmissionYear(reference)
);
check(
  "a year beyond the allowed maximum is rejected",
  parseAdmissionYear(maxAdmissionYear(reference) + 1, reference) === null
);
check("a year before the minimum is rejected", parseAdmissionYear(1999, reference) === null);
check("a numeric string is accepted", parseAdmissionYear("2026", reference) === 2026);
check("a non-numeric string is rejected", parseAdmissionYear("abcd", reference) === null);
check("null is rejected", parseAdmissionYear(null, reference) === null);
check("undefined is rejected", parseAdmissionYear(undefined, reference) === null);
check("a non-integer is rejected", parseAdmissionYear(2026.5, reference) === null);
check(
  "the roll year never falls back to the calendar year",
  parseAdmissionYear(null, reference) !== reference.getUTCFullYear()
);

/* ── 5. Eligibility ────────────────────────────────────────────────────── */

section("5. Enrollment eligibility");

const eligible = decideEnrollment(candidate({ applicationStatus: "verified" }), reference);
check("a verified, complete application is enrollable", eligible.ok === true);
check(
  "the decision carries the validated admission year",
  eligible.ok && eligible.mode === "enroll" && eligible.admissionYear === 2026
);
check("'pending' cannot be enrolled", decideEnrollment(candidate({ applicationStatus: "pending" }), reference).ok === false);
check("'needs_correction' cannot be enrolled", decideEnrollment(candidate({ applicationStatus: "needs_correction" }), reference).ok === false);
check("'rejected' cannot be enrolled", decideEnrollment(candidate({ applicationStatus: "rejected" }), reference).ok === false);

const legacy = decideEnrollment(candidate(), reference);
check("a legacy record without a status is not auto-enrolled", legacy.ok === false);
check(
  "the legacy rejection code names the cause",
  !legacy.ok && legacy.code === "legacy_status_missing" && legacy.status === 409
);

const missingYear = decideEnrollment(
  candidate({ applicationStatus: "verified", admissionYear: null }),
  reference
);
check("a missing admission year is rejected", missingYear.ok === false);
check(
  "a missing admission year is 422 (invalid data)",
  !missingYear.ok && missingYear.status === 422 && missingYear.code === "invalid_admission_year"
);

const badYear = decideEnrollment(
  candidate({ applicationStatus: "verified", admissionYear: 1999 }),
  reference
);
check("an out-of-range admission year is rejected", badYear.ok === false);

const noPhone = decideEnrollment(candidate({ applicationStatus: "verified", phone: "" }), reference);
check("incomplete registration data is rejected", noPhone.ok === false);
check(
  "incomplete registration is 422 (invalid data)",
  !noPhone.ok && noPhone.status === 422 && noPhone.code === "invalid_registration"
);
check(
  "a missing college is rejected",
  decideEnrollment(candidate({ applicationStatus: "verified", college: "" }), reference).ok === false
);
check(
  "an invalid aadhar is rejected",
  decideEnrollment(candidate({ applicationStatus: "verified", aadhar: "123" }), reference).ok === false
);
check(
  "a pending record with identifiers is still rejected",
  decideEnrollment(
    candidate({
      applicationStatus: "pending",
      enrollmentNumber: "EN00000001",
      universityRollNumber: "MSU2026000001",
    }),
    reference
  ).ok === false
);

/* ── 6. Idempotency and conflicting identifiers ────────────────────────── */

section("6. Idempotency and conflicting identifiers");

const enrolled = decideEnrollment(
  candidate({
    applicationStatus: "enrolled",
    enrollmentNumber: "EN00000007",
    universityRollNumber: "MSU2026000003",
  }),
  reference
);
check("an enrolled record with valid identifiers is idempotent", enrolled.ok === true);
check(
  "the idempotent decision returns the existing identifiers",
  enrolled.ok &&
    enrolled.mode === "already_enrolled" &&
    enrolled.enrollmentNumber === "EN00000007" &&
    enrolled.universityRollNumber === "MSU2026000003"
);

const verifiedWithIds = decideEnrollment(
  candidate({
    applicationStatus: "verified",
    enrollmentNumber: "EN00000007",
    universityRollNumber: "MSU2026000003",
  }),
  reference
);
check(
  "a VERIFIED record with both identifiers is idempotent too (nothing regenerated)",
  verifiedWithIds.ok === true &&
    verifiedWithIds.mode === "already_enrolled" &&
    verifiedWithIds.enrollmentNumber === "EN00000007" &&
    verifiedWithIds.universityRollNumber === "MSU2026000003"
);

/* Single-identifier repair: the issued value is preserved and ONLY the missing
 * identifier is planned for allocation. */
const repairRoll = decideEnrollment(
  candidate({ applicationStatus: "verified", enrollmentNumber: "EN00000007" }),
  reference
);
check(
  "only the enrollment number present repairs ONLY the roll number",
  repairRoll.ok === true &&
    repairRoll.mode === "enroll" &&
    repairRoll.allocate === "roll" &&
    repairRoll.admissionYear === 2026
);

const repairEnrollment = decideEnrollment(
  candidate({
    applicationStatus: "verified",
    universityRollNumber: "MSU2026000003",
  }),
  reference
);
check(
  "only the roll number present repairs ONLY the enrollment number",
  repairEnrollment.ok === true &&
    repairEnrollment.mode === "enroll" &&
    repairEnrollment.allocate === "enrollment"
);
check(
  "an enrollment-number-only repair needs no admission year (global sequence)",
  decideEnrollment(
    candidate({
      applicationStatus: "verified",
      admissionYear: null,
      universityRollNumber: "MSU2026000003",
    }),
    reference
  ).ok === true
);
check(
  "a repair never asks for a roll number year other than the admission year",
  decideEnrollment(
    candidate({ applicationStatus: "verified", enrollmentNumber: "EN00000007" }),
    reference
  ).ok === true &&
    (() => {
      const plan = planIdentifierAssignment(
        candidate({ applicationStatus: "verified", enrollmentNumber: "EN00000007" }),
        reference
      );
      return plan.ok && plan.mode === "repair_roll" && plan.admissionYear === 2026;
    })()
);
check(
  "a roll-number-only repair takes the year from the issued roll number",
  (() => {
    const plan = planIdentifierAssignment(
      candidate({
        applicationStatus: "verified",
        admissionYear: null,
        universityRollNumber: "MSU2026000003",
      }),
      reference
    );
    return plan.ok && plan.mode === "repair_enrollment" && plan.admissionYear === 2026;
  })()
);
check(
  "a malformed enrollment number is a conflict, never overwritten",
  decideEnrollment(
    candidate({ applicationStatus: "verified", enrollmentNumber: "EN7" }),
    reference
  ).ok === false
);
check(
  "a malformed roll number is a conflict",
  decideEnrollment(
    candidate({ applicationStatus: "verified", universityRollNumber: "MSU20260000" }),
    reference
  ).ok === false
);
check(
  "an empty-string identifier is NOT an issued identifier (it is filled, not preserved)",
  (() => {
    const d = decideEnrollment(
      candidate({ applicationStatus: "verified", enrollmentNumber: "" }),
      reference
    );
    return d.ok === true && d.mode === "enroll" && d.allocate === "both";
  })()
);
check(
  "an empty-string roll number is repaired without touching the enrollment number",
  (() => {
    const plan = planIdentifierAssignment(
      candidate({ applicationStatus: "verified", universityRollNumber: "" }),
      reference
    );
    return plan.ok && plan.mode === "allocate_both";
  })()
);
check(
  "a roll year that disagrees with the admission year is a conflict",
  decideEnrollment(
    candidate({
      applicationStatus: "enrolled",
      admissionYear: 2027,
      enrollmentNumber: "EN00000007",
      universityRollNumber: "MSU2026000003",
    }),
    reference
  ).ok === false
);
check(
  "'enrolled' without identifiers is a conflict",
  decideEnrollment(candidate({ applicationStatus: "enrolled" }), reference).ok === false
);
check(
  "a non-string identifier is a conflict",
  decideEnrollment(
    candidate({ applicationStatus: "verified", enrollmentNumber: 42 }),
    reference
  ).ok === false
);
check(
  "a conflict message mentions manual remediation",
  (() => {
    const d = decideEnrollment(
      candidate({ applicationStatus: "verified", enrollmentNumber: "EN7" }),
      reference
    );
    return !d.ok && /manual remediation/i.test(d.message);
  })()
);
check(
  "an issued identifier is NEVER part of the allocation plan",
  (() => {
    const plan = planIdentifierAssignment(
      candidate({ applicationStatus: "verified", enrollmentNumber: "EN00000007" }),
      reference
    );
    return plan.ok && plan.mode === "repair_roll" && plan.enrollmentNumber === "EN00000007";
  })()
);
check(
  "no decision message contains a stack trace marker",
  (() => {
    const d = decideEnrollment(candidate({ applicationStatus: "pending" }), reference);
    return !d.ok && !/ at .*\(.*:\d+:\d+\)/.test(d.message);
  })()
);

check(
  "isEnrollmentEligible matches the decision",
  isEnrollmentEligible(candidate({ applicationStatus: "verified" }), reference) === true &&
    isEnrollmentEligible(candidate({ applicationStatus: "pending" }), reference) === false &&
    isEnrollmentEligible(
      candidate({
        applicationStatus: "enrolled",
        enrollmentNumber: "EN00000007",
        universityRollNumber: "MSU2026000003",
      }),
      reference
    ) === false
);

/* ── 7. Legacy-data conflict scan ──────────────────────────────────────── */

section("7. Legacy-data conflict scan (dry run)");

const scan = scanIdentifierConflicts(
  [
    // s1 is a legacy record: no application status stored at all.
    { _id: "s1" },
    { _id: "s2", applicationStatus: "verified", admissionYear: 2026 },
    {
      _id: "s3",
      applicationStatus: "enrolled",
      admissionYear: 2026,
      enrollmentNumber: "EN00000001",
      universityRollNumber: "MSU2026000001",
    },
    {
      _id: "s4",
      applicationStatus: "enrolled",
      admissionYear: 2026,
      enrollmentNumber: "EN00000001",
      universityRollNumber: "MSU2026000001",
    },
    { _id: "s5", applicationStatus: "verified", enrollmentNumber: "EN7" },
    { _id: "s6", applicationStatus: "verified", universityRollNumber: "MSU2026" },
    { _id: "s7", applicationStatus: "verified", enrollmentNumber: "" },
    {
      _id: "s8",
      applicationStatus: "enrolled",
      admissionYear: 2027,
      enrollmentNumber: "EN00000002",
      universityRollNumber: "MSU2026000009",
    },
    { _id: "s9", applicationStatus: "enrolled" },
    { _id: "s10", applicationStatus: "verified", admissionYear: 1800 },
    { _id: "s11" },
  ],
  reference
);

check("the scan counts every record", scan.totalStudents === 11);
check(
  "duplicate enrollment numbers are reported",
  scan.duplicateEnrollmentNumbers.length === 1 &&
    scan.duplicateEnrollmentNumbers[0].value === "EN00000001" &&
    scan.duplicateEnrollmentNumbers[0].studentIds.length === 2
);
check(
  "duplicate roll numbers are reported",
  scan.duplicateUniversityRollNumbers.length === 1 &&
    scan.duplicateUniversityRollNumbers[0].studentIds.length === 2
);
check(
  "malformed enrollment numbers are reported",
  scan.invalidEnrollmentNumbers.some((entry) => entry.studentId === "s5" && entry.value === "EN7")
);
check(
  "malformed roll numbers are reported",
  scan.invalidUniversityRollNumbers.some((entry) => entry.studentId === "s6")
);
check(
  "a roll/admission-year mismatch is reported",
  scan.rollYearMismatches.some((entry) => entry.studentId === "s8")
);
check(
  "a one-identifier record is reported",
  scan.partialIdentifiers.some((entry) => entry.studentId === "s5") &&
    scan.partialIdentifiers.some((entry) => entry.studentId === "s6")
);
check(
  "identifiers with a non-enrolled status are reported",
  scan.identifiersWithNonEnrolledStatus.some((entry) => entry.studentId === "s5")
);
check(
  "'enrolled' without identifiers is reported",
  scan.enrolledWithoutIdentifiers.some((entry) => entry.studentId === "s9")
);
check(
  "an empty-string identifier value is reported",
  scan.blankIdentifierValues.some((entry) => entry.studentId === "s7")
);
check(
  "a missing application status is reported",
  scan.missingApplicationStatus.some((entry) => entry.studentId === "s1") &&
    scan.missingApplicationStatus.some((entry) => entry.studentId === "s11")
);
check(
  "an invalid admission year is reported",
  scan.invalidAdmissionYears.some((entry) => entry.studentId === "s10")
);
check("conflicting records are counted", scan.conflictingRecordCount >= 8);
check("the issue count aggregates every category", scan.issueCount > 0);
check(
  "a clean record set reports no conflicts",
  (() => {
    const clean = scanIdentifierConflicts([
      { _id: "c1", applicationStatus: "verified", admissionYear: 2026 },
      {
        _id: "c2",
        applicationStatus: "enrolled",
        admissionYear: 2026,
        enrollmentNumber: "EN00000001",
        universityRollNumber: "MSU2026000001",
      },
    ]);
    return clean.issueCount === 0 && clean.conflictingRecordCount === 0;
  })()
);
check(
  "the scan reports no personal data (ids and identifiers only)",
  JSON.stringify(scan).indexOf("@") === -1
);

/* ── 8. Schema declarations ────────────────────────────────────────────── */

section("8. Schema declarations");

check(
  "the Counter key is a string namespace",
  Counter.schema.path("_id")?.instance === "String"
);
check(
  "the Counter holds the last allocated value",
  Counter.schema.path("nextValue")?.instance === "Number"
);
check(
  "a new counter document starts at 0",
  new Counter({ _id: "enrollment" }).nextValue === 0
);
check(
  "the Counter declares no extra index (no autoIndex surprise)",
  Counter.schema.indexes().length === 0
);

const eventBase = {
  action: "enrolled" as const,
  studentId: new mongoose.Types.ObjectId(),
  actorAdminId: new mongoose.Types.ObjectId(),
  actorRole: "admin",
  enrollmentNumber: "EN00000001",
  universityRollNumber: "MSU2026000001",
  admissionYear: 2026,
  operationId: "op-1",
  at: new Date(),
};
check(
  "a valid enrollment event validates",
  new EnrollmentEvent(eventBase).validateSync() === undefined
);
check(
  "an event with a malformed enrollment number is rejected",
  new EnrollmentEvent({ ...eventBase, enrollmentNumber: "EN7" }).validateSync() !== undefined
);
check(
  "an event with a malformed roll number is rejected",
  new EnrollmentEvent({ ...eventBase, universityRollNumber: "MSU2026" }).validateSync() !== undefined
);
check(
  "an event without a student reference is rejected",
  new EnrollmentEvent({ ...eventBase, studentId: undefined }).validateSync() !== undefined
);
check(
  "an event without an actor is rejected",
  new EnrollmentEvent({ ...eventBase, actorAdminId: undefined }).validateSync() !== undefined
);
check(
  "an unknown event action is rejected",
  new EnrollmentEvent({ ...eventBase, action: "verified" }).validateSync() !== undefined
);
check(
  "the EnrollmentEvent declares no extra index",
  EnrollmentEvent.schema.indexes().length === 0
);

const declaredStudentIndexes = Student.schema.indexes().map(([key]) => JSON.stringify(key));
check(
  "the Student schema does NOT declare an enrollmentNumber index",
  !declaredStudentIndexes.some((key) => key.includes("enrollmentNumber"))
);
check(
  "the Student schema does NOT declare a universityRollNumber index",
  !declaredStudentIndexes.some((key) => key.includes("universityRollNumber"))
);
check(
  "the approved index intent defines exactly two partial unique indexes",
  ENROLLMENT_INDEX_INTENT.length === 2 &&
    ENROLLMENT_INDEX_INTENT.every(
      (index) =>
        index.options.unique === true &&
        Object.keys(index.options.partialFilterExpression).length === 1
    )
);
check(
  "the index intent matches the official field names",
  ENROLLMENT_INDEX_INTENT[0].key.enrollmentNumber === 1 &&
    ENROLLMENT_INDEX_INTENT[1].key.universityRollNumber === 1
);

/* ── 9. Student read model ─────────────────────────────────────────────── */

section("9. Student read model (toReviewStudent)");

function hyd(overrides: Record<string, unknown> = {}) {
  return Student.hydrate({ ...base, ...overrides });
}

check(
  "a legacy record (no status) is not reported as enrollable",
  toReviewStudent(hyd()).enrollmentEligible === false
);
check(
  "a verified record is reported as enrollable",
  toReviewStudent(hyd({ applicationStatus: "verified" })).enrollmentEligible === true
);
check(
  "a pending record is not reported as enrollable",
  toReviewStudent(hyd({ applicationStatus: "pending" })).enrollmentEligible === false
);
check(
  "a record without an admission year is not reported as enrollable",
  toReviewStudent(hyd({ applicationStatus: "verified", admissionYear: null }))
    .enrollmentEligible === false
);
check(
  "an enrolled record is not reported as enrollable",
  toReviewStudent(
    hyd({
      applicationStatus: "enrolled",
      enrollmentNumber: "EN00000001",
      universityRollNumber: "MSU2026000001",
    })
  ).enrollmentEligible === false
);
check(
  "the read model exposes the assigned identifiers unchanged",
  toReviewStudent(
    hyd({
      applicationStatus: "enrolled",
      enrollmentNumber: "EN00000001",
      universityRollNumber: "MSU2026000001",
    })
  ).enrollmentNumber === "EN00000001"
);
check(
  "the read model exposes the roll number unchanged",
  toReviewStudent(
    hyd({
      applicationStatus: "enrolled",
      enrollmentNumber: "EN00000001",
      universityRollNumber: "MSU2026000001",
    })
  ).universityRollNumber === "MSU2026000001"
);
check(
  "the read model reports enrolledAt as null when absent",
  toReviewStudent(hyd({ applicationStatus: "verified" })).enrolledAt === null
);
check(
  "the read model never exposes enrolledBy",
  !("enrolledBy" in toReviewStudent(hyd({ applicationStatus: "verified" })))
);
check(
  "the read model never exposes the password",
  !("password" in toReviewStudent(hyd({ applicationStatus: "verified" })))
);

/* ── Summary ───────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
