/**
 * Offline verification of Student Management status + delete-confirmation rules.
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. It exercises:
 *   - the pure helpers in lib/validation.ts, and
 *   - the Student model's schema/defaults/safe mapper via validateSync().
 *
 * The live API behaviours (activate/deactivate/hard-delete over HTTP) are
 * covered by scripts/test-student-management-db.ts, which needs a running server.
 *
 * Usage: npx tsx scripts/test-student-management.ts
 */
import Student, { toSafeStudent, type IStudent } from "@/models/Student";
import {
  STUDENT_STATUSES,
  isDeleteConfirmationValid,
  parseStudentStatus,
} from "@/lib/validation";

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

/** A fully-valid unsaved student; override any field per case. */
function student(overrides: Record<string, unknown> = {}) {
  return new Student({
    name: "Aarushi Sharma",
    email: "aarushi@example.com",
    password: "password123",
    course: "BCA",
    aadhar: "123456789012",
    abcId: "ABC123456789",
    phone: "9876543210",
    college: "University College",
    ...overrides,
  });
}

/* ── 1. Status field / defaults ────────────────────────────── */

section("1. Status field and default");

const fresh = student();
check("a new student defaults to ACTIVE", fresh.status === "ACTIVE");
check(
  "the model has exactly one status field (no isActive/deleted overlap)",
  Student.schema.path("status") !== undefined &&
    Student.schema.path("isActive") === undefined &&
    Student.schema.path("active") === undefined &&
    Student.schema.path("disabled") === undefined &&
    Student.schema.path("deleted") === undefined
);
check(
  "the controlled status set is ACTIVE/INACTIVE",
  STUDENT_STATUSES.length === 2 &&
    STUDENT_STATUSES[0] === "ACTIVE" &&
    STUDENT_STATUSES[1] === "INACTIVE"
);
check("a fully valid student passes validation", !fresh.validateSync());
check(
  "an explicit INACTIVE status is valid",
  !student({ status: "INACTIVE" }).validateSync()
);
check(
  "an unknown status is rejected by the model",
  !!student({ status: "DELETED" }).validateSync()
);
check(
  "a lowercase status is rejected by the model (canonical uppercase only)",
  !!student({ status: "active" }).validateSync()
);

/* ── 2. Safe serialization ─────────────────────────────────── */

section("2. toSafeStudent");

const safe = toSafeStudent(fresh);
check("status is exposed", safe.status === "ACTIVE");
check("the password is never exposed", !("password" in safe));
check(
  "legacy documents without a status serialize as ACTIVE",
  toSafeStudent({ ...fresh.toObject(), status: undefined } as unknown as IStudent)
    .status === "ACTIVE"
);

/* ── 3. parseStudentStatus ─────────────────────────────────── */

section("3. parseStudentStatus");

check("\"ACTIVE\" parses", parseStudentStatus("ACTIVE") === "ACTIVE");
check("\"inactive\" normalises to INACTIVE", parseStudentStatus("inactive") === "INACTIVE");
check("surrounding whitespace is trimmed", parseStudentStatus("  Active  ") === "ACTIVE");
check("an unknown value is null", parseStudentStatus("deleted") === null);
check("a non-string is null", parseStudentStatus(123) === null && parseStudentStatus(null) === null);

/* ── 4. Hard-delete confirmation ───────────────────────────── */

section("4. Hard-delete confirmation");

const EMAIL = "Aarushi@Example.com";
check("the exact email confirms", isDeleteConfirmationValid("Aarushi@Example.com", EMAIL));
check("confirmation is case-insensitive", isDeleteConfirmationValid("aarushi@example.com", EMAIL));
check("confirmation is trimmed", isDeleteConfirmationValid("  aarushi@example.com  ", EMAIL));
check("a wrong email is rejected", !isDeleteConfirmationValid("someone@else.com", EMAIL));
check("an empty confirmation is rejected", !isDeleteConfirmationValid("", EMAIL));
check("a non-string confirmation is rejected", !isDeleteConfirmationValid(null, EMAIL));

/* ── Summary ────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All student management checks passed.");
}
