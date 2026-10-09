/**
 * End-to-end verification of Phase 5 enrollment over the real API against a
 * REAL database: eligibility, identifier generation, idempotency, refusals,
 * concurrency, transaction rollback and counter-exhaustion behaviour.
 *
 * ⚠ MUST BE RUN AGAINST AN ISOLATED NON-PRODUCTION DATABASE.
 *
 * This is the only test that can verify database-level guarantees. It writes to
 * the configured database and it advances the shared identifier counters, so it
 * refuses to run unless `--allow-writes` is passed explicitly:
 *
 *   npm run build
 *   npx next start -p 3099            # started against the ISOLATED database
 *   npx tsx scripts/test-enrollment-db.ts --allow-writes
 *
 * Safety:
 * - Temporary records use `codebuff-verify-<hex>-*@example.invalid` addresses.
 * - Cleanup deletes ONLY the exact `_id`s created here (students, the temporary
 *   admin and the EnrollmentEvents belonging to those students) and restores
 *   the counters it changed to their pre-run values.
 * - No password, key, connection string or identifier of an existing record is
 *   ever printed.
 * - No .env value is read directly: dotenv loads the project's existing
 *   configuration, exactly like scripts/test-student-management-db.ts.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import crypto from "crypto";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Admin from "@/models/Admin";
import Student from "@/models/Student";
import Counter, { type ICounter } from "@/models/Counter";
import EnrollmentEvent from "@/models/EnrollmentEvent";
import {
  ENROLLMENT_COUNTER_ID,
  ENROLLMENT_NUMBER_PATTERN,
  UNIVERSITY_ROLL_NUMBER_PATTERN,
  universityRollCounterId,
} from "@/lib/enrollment";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3099";
const ALLOW_WRITES = process.argv.includes("--allow-writes");

/** The counter model typed to its string-keyed documents. */
const CounterModel = Counter as unknown as mongoose.Model<ICounter>;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, reason: string) {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${reason}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

const suffix = crypto.randomBytes(6).toString("hex");
const tempEmail = (label: string) => `codebuff-verify-${suffix}-${label}@example.invalid`;
const tempAdminEmail = tempEmail("admin");

const CURRENT_YEAR = new Date().getFullYear();
const NEXT_YEAR = CURRENT_YEAR + 1;

const seededStudentIds: mongoose.Types.ObjectId[] = [];
let seededAdminId: mongoose.Types.ObjectId | null = null;
let seededInactiveAdminId: mongoose.Types.ObjectId | null = null;

/** Counters touched by this run, with the value to restore in cleanup. */
const counterSnapshot = new Map<string, number | null>();

let ipCounter = 0;

async function api(
  path: string,
  token: string | null,
  method: "GET" | "POST",
  body?: unknown
) {
  ipCounter += 1;
  const ip = `198.51.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;

  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json, text };
}

async function rawStudent(id: mongoose.Types.ObjectId) {
  return Student.collection.findOne({ _id: id });
}

async function eventCount(id: mongoose.Types.ObjectId) {
  return EnrollmentEvent.collection.countDocuments({ studentId: id });
}

async function counterValue(id: string): Promise<number | null> {
  const doc = await CounterModel.findOne({ _id: id }).lean();
  if (!doc) return null;
  const value = doc.nextValue;
  return typeof value === "number" ? value : null;
}

async function rememberCounter(id: string) {
  if (!counterSnapshot.has(id)) {
    counterSnapshot.set(id, await counterValue(id));
  }
}

async function setCounter(id: string, value: number) {
  await rememberCounter(id);
  await CounterModel.updateOne(
    { _id: id },
    { $set: { nextValue: value } },
    { upsert: true }
  );
}

/**
 * Does this deployment support multi-document transactions?
 *
 * The production operations use a transaction when one is available and fall
 * back to the same atomic single-document operations on a standalone
 * deployment (see @/lib/enrollment-service). A few guarantees differ between
 * the two modes — a lost race or a failed operation can leave a GAP in a
 * sequence when there is no transaction to roll the counter back — so those
 * assertions are checked against the mode actually in use and the mode is
 * reported in the output.
 */
async function probeTransactionSupport(): Promise<boolean> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Student.collection.findOne({}, { session, projection: { _id: 1 } });
    });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 20) return false;
    throw error;
  } finally {
    await session.endSession();
  }
}

/** A complete, verified, identifier-free registration payload. */
function randomDigits(length: number): string {
  let out = "";
  while (out.length < length) out += String(crypto.randomInt(0, 10));
  return out.slice(0, length);
}

function randomAlphaNum(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out.slice(0, length);
}

function registrationPayload(label: string, extra: Record<string, unknown> = {}) {
  return {
    name: `Temp ${label} Student`,
    email: tempEmail(label),
    username: `temp-${label}`,
    password: "unused-for-verify",
    course: "BCA",
    // Unique per run so the existing unique aadhar/abcId indexes never collide
    // with a real record (they are only ever written to an isolated database).
    aadhar: `9${randomDigits(11)}`,
    abcId: randomAlphaNum(12),
    phone: `9${randomDigits(9)}`,
    college: "Verify College",
    profileImage: "",
    status: "ACTIVE",
    gender: "Male",
    fatherName: "Verify Father",
    motherName: "Verify Mother",
    admissionYear: CURRENT_YEAR,
    accountStatus: "active",
    registeredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    __v: 0,
    ...extra,
  };
}

async function seedStudent(label: string, extra: Record<string, unknown> = {}) {
  const id = (
    await Student.collection.insertOne(registrationPayload(label, extra))
  ).insertedId as mongoose.Types.ObjectId;
  seededStudentIds.push(id);
  return id;
}

/** One seeded admin identity used to mint tokens (never a real admin). */
let adminIdString = "";
let token = "";

async function main() {
  const { generateAdminToken } = await import("@/lib/auth-helpers");

  if (!ALLOW_WRITES) {
    console.error(
      [
        "Refusing to run: this test writes temporary records and advances the",
        "identifier counters, so it must only run against an ISOLATED database.",
        "",
        "Re-run with --allow-writes (and TEST_BASE_URL) once the isolated",
        "non-production database and server are available:",
        "",
        "  npx next start -p 3099          # started against the ISOLATED database",
        "  npx tsx scripts/test-enrollment-db.ts --allow-writes",
      ].join("\n")
    );
    process.exit(2);
  }

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run with NODE_ENV=production.");
    process.exit(2);
  }

  console.log(
    `Verifying against ${BASE} (temporary records, counters restored at the end)`
  );
  await connectDB();
  const transactionsSupported = await probeTransactionSupport();
  console.log(
    `Deployment mode: ${
      transactionsSupported
        ? "multi-document transactions (replica set / mongos)"
        : "standalone — atomic single-document fallback"
    }`
  );

  /* ── Seed the temporary admin ─────────────────────────────────────────── */
  seededAdminId = (
    await Admin.collection.insertOne({
      name: "Temp Verify Admin",
      email: tempAdminEmail,
      password: "unused-for-token-only",
      role: "admin",
      status: "active",
      lastLogin: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    })
  ).insertedId as mongoose.Types.ObjectId;

  adminIdString = String(seededAdminId);
  token = generateAdminToken(adminIdString, "admin");

  /*
   * A second, DEACTIVATED admin. Any active admin may enroll (approved policy),
   * so the meaningful authorization negative case is a valid token held by an
   * admin whose account is no longer active — the role/status must be re-read
   * from the database on every request, never taken from the token.
   */
  seededInactiveAdminId = (
    await Admin.collection.insertOne({
      name: "Temp Verify Inactive Admin",
      email: tempEmail("inactive-admin"),
      password: "unused-for-token-only",
      role: "admin",
      status: "inactive",
      lastLogin: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    })
  ).insertedId as mongoose.Types.ObjectId;
  const inactiveAdminToken = generateAdminToken(
    String(seededInactiveAdminId),
    "admin"
  );

  /* ── Seed the fixtures ────────────────────────────────────────────────── */
  const verifiedId = await seedStudent("verified", {
    applicationStatus: "verified",
    correctionMessage: "Legacy correction note",
    reviewHistory: [
      {
        action: "verify",
        fromStatus: "pending",
        toStatus: "verified",
        reason: "",
        fields: [],
        additionalInstructions: "",
        actorId: adminIdString,
        actorRole: "admin",
        at: new Date(),
      },
    ],
  });
  const pendingId = await seedStudent("pending", { applicationStatus: "pending" });
  const correctionId = await seedStudent("correction", {
    applicationStatus: "needs_correction",
  });
  const rejectedId = await seedStudent("rejected", { applicationStatus: "rejected" });
  // Legacy shape: no applicationStatus at all (reads as verified, must NOT enroll).
  const legacyId = await seedStudent("legacy");
  const partialId = await seedStudent("partial", {
    applicationStatus: "verified",
    enrollmentNumber: "EN0TEST",
  });
  const partialValidId = await seedStudent("partial-valid", {
    applicationStatus: "verified",
    enrollmentNumber: "EN00090001",
  });
  const alreadyEnrolledId = await seedStudent("already-enrolled", {
    applicationStatus: "enrolled",
    enrollmentNumber: "EN00090002",
    universityRollNumber: `MSU${CURRENT_YEAR}990001`,
    enrolledAt: new Date(),
    enrolledBy: adminIdString,
  });
  const enrolledNoIdsId = await seedStudent("enrolled-no-ids", {
    applicationStatus: "enrolled",
  });
  const missingYearId = await seedStudent("missing-year", {
    applicationStatus: "verified",
    admissionYear: null,
  });
  const incompleteId = await seedStudent("incomplete", {
    applicationStatus: "verified",
    phone: "",
    college: "",
  });
  const sequentialId = await seedStudent("sequential", {
    applicationStatus: "verified",
  });
  const concurrencySameId = await seedStudent("concurrency-same", {
    applicationStatus: "verified",
  });
  const concurrencyAId = await seedStudent("concurrency-a", {
    applicationStatus: "verified",
  });
  const concurrencyBId = await seedStudent("concurrency-b", {
    applicationStatus: "verified",
  });
  const exhaustGlobalId = await seedStudent("exhaust-global", {
    applicationStatus: "verified",
  });
  const exhaustRollId = await seedStudent("exhaust-roll", {
    applicationStatus: "verified",
  });
  const partialRollId = await seedStudent("partial-roll", {
    applicationStatus: "verified",
    universityRollNumber: `MSU${CURRENT_YEAR}990002`,
  });

  /* Fixtures for the VERIFICATION workflow (approve + assign identifiers). */
  const verifyNewId = await seedStudent("verify-new", {
    applicationStatus: "pending",
    accountStatus: "pending",
    verifiedAt: null,
  });
  const verifyLockedId = await seedStudent("verify-locked", {
    applicationStatus: "pending",
    accountStatus: "locked",
  });
  const verifyForgedId = await seedStudent("verify-forged", {
    applicationStatus: "pending",
    accountStatus: "pending",
  });
  const verifyRejectedId = await seedStudent("verify-rejected", {
    applicationStatus: "rejected",
    accountStatus: "pending",
    rejectionReason: "Documents could not be verified.",
  });
  const verifyLegacyId = await seedStudent("verify-legacy", {});
  const verifyIncompleteId = await seedStudent("verify-incomplete", {
    applicationStatus: "pending",
    accountStatus: "pending",
    phone: "",
  });
  const verifyPartialId = await seedStudent("verify-partial", {
    applicationStatus: "verified",
    accountStatus: "pending",
    enrollmentNumber: "EN00095001",
  });
  const verifyConcurrentId = await seedStudent("verify-concurrent", {
    applicationStatus: "pending",
    accountStatus: "pending",
  });

  await rememberCounter(ENROLLMENT_COUNTER_ID);
  await rememberCounter(universityRollCounterId(CURRENT_YEAR));
  await rememberCounter(universityRollCounterId(NEXT_YEAR));

  try {
    /* ── 1. Authorization and input validation ─────────────────────────── */
    section("1. Authorization and input validation");

    const noToken = await api(`/api/admin/students/${verifiedId}/enroll`, null, "POST");
    check("an unauthenticated call is rejected (401)", noToken.status === 401);

    try {
      const jwtModule = await import("jsonwebtoken");
      // Signed with the PUBLIC STUDENT key (the legacy JWT_SECRET the public
      // app uses), NOT the admin key: the admin verifier must now reject this
      // during SIGNATURE verification — 401 — before any `role`/authorization
      // check runs. (The two applications keep separate keys; see
      // lib/auth-helpers.ts. If ADMIN_JWT_SECRET were misconfigured to equal
      // the student secret, this assertion fails on purpose.)
      const studentToken = jwtModule.default.sign(
        { sub: new mongoose.Types.ObjectId().toString(), role: "student" },
        process.env.JWT_SECRET as string,
        { expiresIn: "1h", algorithm: "HS256" }
      );
      const studentCall = await api(
        `/api/admin/students/${verifiedId}/enroll`,
        studentToken,
        "POST"
      );
      check(
        "a student-signed token is rejected at signature verification (401)",
        studentCall.status === 401,
        `${studentCall.status}`
      );
    } catch {
      skip(
        "a student-signed token is rejected at signature verification (401)",
        "JWT_SECRET unavailable in-process"
      );
    }

    const deactivatedAdminCall = await api(
      `/api/admin/students/${verifiedId}/enroll`,
      inactiveAdminToken,
      "POST"
    );
    check(
      "a deactivated admin's valid token is rejected (403)",
      deactivatedAdminCall.status === 403,
      `${deactivatedAdminCall.status}`
    );
    check(
      "the deactivated admin's call wrote nothing",
      (await rawStudent(verifiedId))?.enrollmentNumber === undefined &&
        (await eventCount(verifiedId)) === 0
    );

    const badId = await api("/api/admin/students/not-an-id/enroll", token, "POST");
    check("an invalid student id is rejected (400)", badId.status === 400);

    const unknownId = await api(
      `/api/admin/students/${new mongoose.Types.ObjectId().toString()}/enroll`,
      token,
      "POST"
    );
    check("an unknown student is 404", unknownId.status === 404);
    check(
      "the 404 body is a safe generic message",
      typeof unknownId.json.message === "string" &&
        !/mongo|stack|at .*:\d+:\d+/.test(String(unknownId.json.message))
    );
    check(
      "no identifiers were written by the rejected calls",
      (await rawStudent(verifiedId))?.enrollmentNumber === undefined
    );

    /* ── 2. Successful enrollment ──────────────────────────────────────── */
    section("2. Enrolling an eligible verified student");

    const before = await rawStudent(verifiedId);
    const enrollmentCounterBefore = await counterValue(ENROLLMENT_COUNTER_ID);
    const rollCounterBefore = await counterValue(universityRollCounterId(CURRENT_YEAR));
    const otherYearRollBefore = await counterValue(universityRollCounterId(NEXT_YEAR));

    const enrolled = await api(`/api/admin/students/${verifiedId}/enroll`, token, "POST");
    check("enrollment succeeds (200)", enrolled.status === 200, enrolled.text.slice(0, 120));
    check("the response reports success", enrolled.json.success === true);
    check("the response is not flagged already-enrolled", enrolled.json.alreadyEnrolled === false);

    const after = await rawStudent(verifiedId);
    const assignedEnrollment = String(after?.enrollmentNumber ?? "");
    const assignedRoll = String(after?.universityRollNumber ?? "");

    check(
      "the enrollment number matches EN########",
      ENROLLMENT_NUMBER_PATTERN.test(assignedEnrollment),
      assignedEnrollment
    );
    check(
      "the roll number matches MSUYYYY######",
      UNIVERSITY_ROLL_NUMBER_PATTERN.test(assignedRoll),
      assignedRoll
    );
    check(
      "the roll number year is the admission year, not the calendar year",
      assignedRoll.startsWith(`MSU${CURRENT_YEAR}`)
    );
    check("the application status became enrolled", after?.applicationStatus === "enrolled");
    check("enrolledAt was set by the server", after?.enrolledAt instanceof Date);
    check("enrolledBy is the authenticated admin", after?.enrolledBy === adminIdString);
    check(
      "the API returned exactly the stored identifiers",
      (enrolled.json.student as { enrollmentNumber?: string } | undefined)
        ?.enrollmentNumber === assignedEnrollment &&
        (enrolled.json.student as { universityRollNumber?: string } | undefined)
          ?.universityRollNumber === assignedRoll
    );
    check(
      "registration data was not modified",
      after?.name === before?.name &&
        after?.email === before?.email &&
        after?.course === before?.course &&
        after?.college === before?.college &&
        after?.phone === before?.phone &&
        after?.admissionYear === before?.admissionYear
    );
    check("the account status was not changed", (after?.accountStatus ?? "active") === "active");
    check("the account lifecycle status was not changed", after?.status === "ACTIVE");
    check(
      "the Phase 4 review history was preserved",
      Array.isArray(after?.reviewHistory) &&
        after?.reviewHistory.length === 1 &&
        after?.reviewHistory[0]?.action === "verify"
    );
    check(
      "the legacy correction note was preserved",
      after?.correctionMessage === "Legacy correction note"
    );
    check(
      "verification metadata was preserved",
      before?.verifiedAt === undefined || after?.verifiedAt === before?.verifiedAt
    );

    check(
      "exactly one enrollment event was recorded",
      (await eventCount(verifiedId)) === 1
    );
    const event = await EnrollmentEvent.collection.findOne({ studentId: verifiedId });
    check("the event action is 'enrolled'", event?.action === "enrolled");
    check(
      "the event records the generated identifiers",
      event?.enrollmentNumber === assignedEnrollment &&
        event?.universityRollNumber === assignedRoll
    );
    check("the event records the authenticated admin", String(event?.actorAdminId) === adminIdString);
    check("the event carries a server timestamp", event?.at instanceof Date);
    check(
      "the event carries an operation id",
      typeof event?.operationId === "string" && (event?.operationId ?? "").length > 0
    );

    check(
      "the global enrollment counter advanced by exactly one",
      (await counterValue(ENROLLMENT_COUNTER_ID)) === (enrollmentCounterBefore ?? 0) + 1
    );
    check(
      "the admission-year roll counter advanced by exactly one",
      (await counterValue(universityRollCounterId(CURRENT_YEAR))) ===
        (rollCounterBefore ?? 0) + 1
    );
    check(
      "another admission year's sequence was not touched",
      (await counterValue(universityRollCounterId(NEXT_YEAR))) === otherYearRollBefore
    );

    /* ── 3. The sequences are independent ──────────────────────────────── */
    section("3. Independent sequences");

    const second = await api(`/api/admin/students/${sequentialId}/enroll`, token, "POST");
    check("a second student enrolls (200)", second.status === 200);
    const secondRoll = String((await rawStudent(sequentialId))?.universityRollNumber ?? "");
    check(
      "the next roll number in the same year increments",
      secondRoll === `MSU${CURRENT_YEAR}${String(Number(assignedRoll.slice(9)) + 1).padStart(6, "0")}`,
      `${assignedRoll} → ${secondRoll}`
    );
    check(
      "the enrollment number does not derive from the roll number",
      !assignedEnrollment.includes(CURRENT_YEAR.toString())
    );
    check(
      "the two students received different identifier pairs",
      String((await rawStudent(sequentialId))?.enrollmentNumber ?? "") !== assignedEnrollment
    );

    /* ── 4. Client-supplied values are ignored ─────────────────────────── */
    section("4. Client-supplied values are ignored");

    const clientValuesId = await seedStudent("client-values", {
      applicationStatus: "verified",
    });
    const forged = await api(`/api/admin/students/${clientValuesId}/enroll`, token, "POST", {
      applicationStatus: "rejected",
      accountStatus: "locked",
      enrollmentNumber: "EN99999999",
      universityRollNumber: "MSU1999999999",
      enrolledAt: "2000-01-01T00:00:00.000Z",
      enrolledBy: new mongoose.Types.ObjectId().toString(),
      verifiedAt: "2000-01-01T00:00:00.000Z",
      verifiedBy: new mongoose.Types.ObjectId().toString(),
      counter: { nextValue: 1 },
      sequence: 1,
      nextValue: 1,
      reviewerId: "attacker",
      operationId: "forged",
    });
    check("the request still succeeds (the body is ignored)", forged.status === 200);
    const clientValuesDoc = await rawStudent(clientValuesId);
    check(
      "the forged enrollment number was not stored",
      clientValuesDoc?.enrollmentNumber !== "EN99999999" &&
        ENROLLMENT_NUMBER_PATTERN.test(String(clientValuesDoc?.enrollmentNumber ?? ""))
    );
    check(
      "the forged roll number was not stored",
      clientValuesDoc?.universityRollNumber !== "MSU1999999999"
    );
    check(
      "the forged status was not stored",
      clientValuesDoc?.applicationStatus === "enrolled"
    );
    check(
      "the forged account status was not stored",
      clientValuesDoc?.accountStatus === "active"
    );
    check(
      "the forged enrolledBy was not stored",
      clientValuesDoc?.enrolledBy === adminIdString
    );
    check(
      "the forged timestamp was not stored",
      clientValuesDoc?.enrolledAt instanceof Date &&
        (clientValuesDoc?.enrolledAt as Date).getFullYear() >= CURRENT_YEAR
    );
    check(
      "the forged verifiedAt was not stored",
      clientValuesDoc?.verifiedAt === undefined ||
        (clientValuesDoc?.verifiedAt as Date).getFullYear() >= CURRENT_YEAR
    );

    /* ── 5. Idempotency ────────────────────────────────────────────────── */
    section("5. Idempotency");

    const enrollmentCounterAfterFirst = await counterValue(ENROLLMENT_COUNTER_ID);
    const rollCounterAfterFirst = await counterValue(universityRollCounterId(CURRENT_YEAR));

    const repeat = await api(`/api/admin/students/${verifiedId}/enroll`, token, "POST");
    check("a repeat request succeeds (200)", repeat.status === 200);
    check("the repeat is reported as already enrolled", repeat.json.alreadyEnrolled === true);
    check(
      "the repeat returns the existing identifiers",
      String((await rawStudent(verifiedId))?.enrollmentNumber) === assignedEnrollment &&
        String((await rawStudent(verifiedId))?.universityRollNumber) === assignedRoll
    );
    check(
      "the repeat allocated no new enrollment number",
      (await counterValue(ENROLLMENT_COUNTER_ID)) === enrollmentCounterAfterFirst
    );
    check(
      "the repeat allocated no new roll number",
      (await counterValue(universityRollCounterId(CURRENT_YEAR))) === rollCounterAfterFirst
    );
    check(
      "the repeat created no second event",
      (await eventCount(verifiedId)) === 1
    );

    const alreadyEnrolled = await api(
      `/api/admin/students/${alreadyEnrolledId}/enroll`,
      token,
      "POST"
    );
    check("a seeded already-enrolled student returns 200", alreadyEnrolled.status === 200);
    check("it is reported as already enrolled", alreadyEnrolled.json.alreadyEnrolled === true);
    check(
      "its existing identifiers were returned unchanged",
      String((await rawStudent(alreadyEnrolledId))?.enrollmentNumber) === "EN00090002" &&
        String((await rawStudent(alreadyEnrolledId))?.universityRollNumber) ===
          `MSU${CURRENT_YEAR}990001`
    );
    check(
      "no event was created for an idempotent repeat",
      (await eventCount(alreadyEnrolledId)) === 0
    );

    /* ── 6. Refusals ───────────────────────────────────────────────────── */
    section("6. Ineligible and conflicting records are refused");

    const refusals: [string, mongoose.Types.ObjectId, number][] = [
      ["pending", pendingId, 409],
      ["needs_correction", correctionId, 409],
      ["rejected", rejectedId, 409],
      ["legacy (no application status)", legacyId, 409],
      ["malformed partial identifier", partialId, 409],
      ["enrolled without identifiers", enrolledNoIdsId, 409],
      ["missing admission year", missingYearId, 422],
      ["incomplete registration", incompleteId, 422],
    ];

    for (const [label, id, expected] of refusals) {
      const docBefore = await rawStudent(id);
      const res = await api(`/api/admin/students/${id}/enroll`, token, "POST");
      check(`${label} is refused (${expected})`, res.status === expected, `${res.status}`);
      const docAfter = await rawStudent(id);
      check(
        `${label} was not modified at all`,
        JSON.stringify(docBefore) === JSON.stringify(docAfter)
      );
      check(`${label} got no enrollment event`, (await eventCount(id)) === 0);
    }

    check(
      "the malformed legacy identifier was not overwritten",
      (await rawStudent(partialId))?.enrollmentNumber === "EN0TEST"
    );
    check(
      "a refusal message names manual remediation where required",
      /manual remediation/i.test(
        String(
          (await api(`/api/admin/students/${partialId}/enroll`, token, "POST")).json
            .message ?? ""
        )
      )
    );

    /* ── 6b. Repairing a single missing identifier ────────────────────── */
    section("6b. A single missing identifier is repaired, never replaced");

    const globalBeforeRepair = await counterValue(ENROLLMENT_COUNTER_ID);
    const rollBeforeRepair = await counterValue(universityRollCounterId(CURRENT_YEAR));

    const repairedRoll = await api(
      `/api/admin/students/${partialValidId}/enroll`,
      token,
      "POST"
    );
    check("a record with only an enrollment number is repaired (200)", repairedRoll.status === 200, repairedRoll.text.slice(0, 120));
    check("the repair is reported as a repair", repairedRoll.json.repaired === true);
    const repairedRollDoc = await rawStudent(partialValidId);
    check(
      "the already-issued enrollment number was PRESERVED",
      repairedRollDoc?.enrollmentNumber === "EN00090001"
    );
    check(
      "the missing university roll number was assigned for the admission year",
      UNIVERSITY_ROLL_NUMBER_PATTERN.test(String(repairedRollDoc?.universityRollNumber ?? "")) &&
        String(repairedRollDoc?.universityRollNumber).startsWith(`MSU${CURRENT_YEAR}`)
    );
    check(
      "the repair allocated no NEW enrollment number",
      (await counterValue(ENROLLMENT_COUNTER_ID)) === globalBeforeRepair
    );
    check(
      "the repair allocated exactly one roll number",
      (await counterValue(universityRollCounterId(CURRENT_YEAR))) ===
        (rollBeforeRepair ?? 0) + 1
    );
    const repairEvent = await EnrollmentEvent.collection.findOne({
      studentId: partialValidId,
    });
    check("the repair was audited", repairEvent?.action === "enrolled");
    check(
      "the audit records both identifiers (issued + newly assigned)",
      repairEvent?.enrollmentNumber === "EN00090001" &&
        repairEvent?.universityRollNumber === repairedRollDoc?.universityRollNumber
    );

    const globalBeforeRepair2 = await counterValue(ENROLLMENT_COUNTER_ID);
    const rollBeforeRepair2 = await counterValue(universityRollCounterId(CURRENT_YEAR));
    const repairedEnrollment = await api(
      `/api/admin/students/${partialRollId}/enroll`,
      token,
      "POST"
    );
    check(
      "a record with only a roll number is repaired (200)",
      repairedEnrollment.status === 200,
      repairedEnrollment.text.slice(0, 120)
    );
    const repairedEnrollmentDoc = await rawStudent(partialRollId);
    check(
      "the already-issued roll number was PRESERVED",
      repairedEnrollmentDoc?.universityRollNumber === `MSU${CURRENT_YEAR}990002`
    );
    check(
      "the missing enrollment number was assigned in EN######## form",
      ENROLLMENT_NUMBER_PATTERN.test(String(repairedEnrollmentDoc?.enrollmentNumber ?? ""))
    );
    check(
      "the enrollment-number repair allocated exactly one global value",
      (await counterValue(ENROLLMENT_COUNTER_ID)) === (globalBeforeRepair2 ?? 0) + 1
    );
    check(
      "the enrollment-number repair allocated no new roll number",
      (await counterValue(universityRollCounterId(CURRENT_YEAR))) === rollBeforeRepair2
    );
    check(
      "the repaired record is now enrolled",
      repairedEnrollmentDoc?.applicationStatus === "enrolled"
    );

    /* ── 7. Concurrency ────────────────────────────────────────────────── */
    section("7. Concurrency (real database)");

    const beforeSame = await counterValue(ENROLLMENT_COUNTER_ID);
    const [raceA, raceB] = await Promise.all([
      api(`/api/admin/students/${concurrencySameId}/enroll`, token, "POST"),
      api(`/api/admin/students/${concurrencySameId}/enroll`, token, "POST"),
    ]);
    const successful = [raceA, raceB].filter((r) => r.status === 200);
    check("at least one concurrent request succeeds", successful.length >= 1);
    check(
      "no concurrent request returns a server error",
      [raceA, raceB].every((r) => r.status === 200 || r.status === 409),
      `${raceA.status}/${raceB.status}`
    );
    const pairs = new Set(
      successful.map((r) => {
        const student = r.json.student as
          | { enrollmentNumber?: string; universityRollNumber?: string }
          | undefined;
        return `${student?.enrollmentNumber}|${student?.universityRollNumber}`;
      })
    );
    check("both concurrent responses report the same identifier pair", pairs.size === 1);
    const concurrentDoc = await rawStudent(concurrencySameId);
    check(
      "the stored pair matches the reported pair",
      pairs.has(
        `${concurrentDoc?.enrollmentNumber}|${concurrentDoc?.universityRollNumber}`
      )
    );
    check("exactly one event was created", (await eventCount(concurrencySameId)) === 1);
    const afterSame = await counterValue(ENROLLMENT_COUNTER_ID);
    check(
      transactionsSupported
        ? "exactly one enrollment number was allocated (transactional deployment)"
        : "the losing race consumed no duplicate — only a sequence gap (standalone fallback)",
      transactionsSupported
        ? afterSame === (beforeSame ?? 0) + 1
        : (afterSame ?? 0) >= (beforeSame ?? 0) + 1
    );

    const [raceC, raceD] = await Promise.all([
      api(`/api/admin/students/${concurrencyAId}/enroll`, token, "POST"),
      api(`/api/admin/students/${concurrencyBId}/enroll`, token, "POST"),
    ]);
    check(
      "two different students can be enrolled concurrently without a server error",
      [raceC, raceD].every((r) => r.status === 200 || r.status === 409),
      `${raceC.status}/${raceD.status}`
    );
    const docA = await rawStudent(concurrencyAId);
    const docB = await rawStudent(concurrencyBId);
    const allEnrolled = await Student.collection
      .find({
        _id: { $in: seededStudentIds },
        enrollmentNumber: { $type: "string", $ne: "" },
      })
      .project({ enrollmentNumber: 1, universityRollNumber: 1 })
      .toArray();
    const enrollmentNumbers = allEnrolled.map((d) => d.enrollmentNumber);
    /*
     * Only real roll-number values can conflict: the `partial` and
     * `partial-valid` fixtures are seeded with an enrollment number and NO roll
     * number on purpose (they must stay uncompleted), so their `undefined`
     * value must not be compared as if it were a duplicate identifier.
     */
    const rollNumbers = allEnrolled
      .map((d) => d.universityRollNumber)
      .filter((value): value is string => typeof value === "string" && value !== "");
    check(
      "no duplicate enrollment number exists after concurrent allocation",
      new Set(enrollmentNumbers).size === enrollmentNumbers.length
    );
    check(
      "no duplicate university roll number exists after concurrent allocation",
      new Set(rollNumbers).size === rollNumbers.length
    );
    check(
      "the roll-number uniqueness check actually covered identifiers",
      rollNumbers.length > 0 && new Set(rollNumbers).size > 1,
      `${rollNumbers.length} roll number(s)`
    );
    check(
      "no allocation produced a roll number without an enrollment number",
      allEnrolled
        .filter(
          (d) => typeof d.universityRollNumber === "string" && d.universityRollNumber !== ""
        )
        .every((d) => typeof d.enrollmentNumber === "string" && d.enrollmentNumber !== "")
    );
    if (docA?.enrollmentNumber && docB?.enrollmentNumber) {
      check(
        "the two concurrent students received different pairs",
        docA.enrollmentNumber !== docB.enrollmentNumber &&
          docA.universityRollNumber !== docB.universityRollNumber
      );
    } else {
      skip(
        "the two concurrent students received different pairs",
        "one of the concurrent requests did not enroll (safe refusal)"
      );
    }

    /* ── 8. Transaction rollback / counter exhaustion ──────────────────── */
    section("8. Failure handling and transaction rollback");

    const rollCounterKey = universityRollCounterId(CURRENT_YEAR);
    await setCounter(ENROLLMENT_COUNTER_ID, 99_999_999);
    await rememberCounter(rollCounterKey);
    const rollBeforeExhaustion = await counterValue(rollCounterKey);

    const exhaustedGlobal = await api(
      `/api/admin/students/${exhaustGlobalId}/enroll`,
      token,
      "POST"
    );
    check("an exhausted global sequence is refused (409)", exhaustedGlobal.status === 409);
    check(
      "the exhaustion message names the limit",
      /EN99999999/.test(String(exhaustedGlobal.json.message ?? ""))
    );
    const exhaustGlobalDoc = await rawStudent(exhaustGlobalId);
    check(
      "the student was NOT marked enrolled",
      exhaustGlobalDoc?.applicationStatus === "verified"
    );
    check("no identifier was written", !exhaustGlobalDoc?.enrollmentNumber);
    check("no enrollment event was created", (await eventCount(exhaustGlobalId)) === 0);
    check(
      transactionsSupported
        ? "the consumed counter value was rolled back (transactional deployment)"
        : "the exhausted counter was left past its limit — a gap, never a duplicate (standalone fallback)",
      transactionsSupported
        ? (await counterValue(ENROLLMENT_COUNTER_ID)) === 99_999_999
        : (await counterValue(ENROLLMENT_COUNTER_ID)) === 100_000_000
    );
    check(
      "the roll counter was never advanced by the aborted attempt",
      (await counterValue(rollCounterKey)) === rollBeforeExhaustion
    );

    // Restore the global counter, then exhaust only the admission-year sequence.
    const globalOriginal = counterSnapshot.get(ENROLLMENT_COUNTER_ID) ?? 0;
    await setCounter(ENROLLMENT_COUNTER_ID, globalOriginal);
    await setCounter(rollCounterKey, 999_999);

    const exhaustedRoll = await api(
      `/api/admin/students/${exhaustRollId}/enroll`,
      token,
      "POST"
    );
    check("an exhausted per-year roll sequence is refused (409)", exhaustedRoll.status === 409);
    check(
      "the roll exhaustion message names the admission-year sequence",
      /university roll number sequence is exhausted/i.test(
        String(exhaustedRoll.json.message ?? "")
      )
    );
    const exhaustRollDoc = await rawStudent(exhaustRollId);
    check(
      "the student was NOT marked enrolled",
      exhaustRollDoc?.applicationStatus === "verified"
    );
    check("no identifier was written", !exhaustRollDoc?.enrollmentNumber);
    check("no enrollment event was created", (await eventCount(exhaustRollId)) === 0);
    check(
      transactionsSupported
        ? "the roll counter was not advanced past its limit"
        : "the exhausted roll counter was left past its limit — a gap, never a duplicate (standalone fallback)",
      (await counterValue(rollCounterKey)) === (transactionsSupported ? 999_999 : 1_000_000)
    );
    check(
      transactionsSupported
        ? "the enrollment value allocated earlier in the same aborted transaction was rolled back too"
        : "the enrollment value allocated before the failed roll allocation left only a gap (standalone fallback)",
      transactionsSupported
        ? (await counterValue(ENROLLMENT_COUNTER_ID)) === globalOriginal
        : (await counterValue(ENROLLMENT_COUNTER_ID)) === globalOriginal + 1
    );

    /* Both sequences are restored (cleanup will restore the run's originals). */
    await setCounter(ENROLLMENT_COUNTER_ID, 5000);
    await setCounter(rollCounterKey, 5000);
    await setCounter(universityRollCounterId(NEXT_YEAR), 5000);

    /* ── 9. Verification assigns both official identifiers ─────────────── */
    section("9. Verifying an application assigns both official identifiers");

    const verifyEnrollmentBefore = await counterValue(ENROLLMENT_COUNTER_ID);
    const verifyRollBefore = await counterValue(universityRollCounterId(CURRENT_YEAR));

    const verified = await api(
      `/api/admin/students/${verifyNewId}/review`,
      token,
      "POST",
      { action: "verify" }
    );
    check("verification succeeds (200)", verified.status === 200, verified.text.slice(0, 160));
    check("the response reports success", verified.json.success === true);
    check(
      "the response reports that the identifiers were assigned",
      verified.json.identifiersAssigned === true
    );
    check(
      "the response reports that the account was activated",
      verified.json.accountActivated === true
    );
    check("the response is not a repeat", verified.json.alreadyVerified === false);

    const verifiedDoc = await rawStudent(verifyNewId);
    const verifiedEnrollment = String(verifiedDoc?.enrollmentNumber ?? "");
    const verifiedRoll = String(verifiedDoc?.universityRollNumber ?? "");
    check(
      "the enrollment number matches EN########",
      ENROLLMENT_NUMBER_PATTERN.test(verifiedEnrollment),
      verifiedEnrollment
    );
    check(
      "the roll number matches MSUYYYY######",
      UNIVERSITY_ROLL_NUMBER_PATTERN.test(verifiedRoll),
      verifiedRoll
    );
    check(
      "the roll number year is the stored admission year, not the calendar year",
      verifiedRoll.startsWith(`MSU${CURRENT_YEAR}`)
    );
    check(
      "the application is approved after verification",
      verifiedDoc?.applicationStatus === "verified"
    );
    check(
      "the approval activated the pending student account",
      verifiedDoc?.accountStatus === "active"
    );
    check("verifiedAt was set by the server", verifiedDoc?.verifiedAt instanceof Date);
    check("verifiedBy is the authenticated admin", verifiedDoc?.verifiedBy === adminIdString);
    check(
      "a review-history entry was appended",
      Array.isArray(verifiedDoc?.reviewHistory) &&
        verifiedDoc.reviewHistory.length === 1 &&
        verifiedDoc.reviewHistory[0]?.action === "verify" &&
        verifiedDoc.reviewHistory[0]?.fromStatus === "pending" &&
        verifiedDoc.reviewHistory[0]?.toStatus === "verified"
    );
    check(
      "the API returned exactly the persisted identifiers",
      (verified.json.student as { enrollmentNumber?: string } | undefined)
        ?.enrollmentNumber === verifiedEnrollment &&
        (verified.json.student as { universityRollNumber?: string } | undefined)
          ?.universityRollNumber === verifiedRoll
    );
    check(
      "the confirmation message names both identifiers",
      String(verified.json.message ?? "").includes(verifiedEnrollment) &&
        String(verified.json.message ?? "").includes(verifiedRoll)
    );
    check(
      "exactly one enrollment number was allocated",
      (await counterValue(ENROLLMENT_COUNTER_ID)) === (verifyEnrollmentBefore ?? 0) + 1
    );
    check(
      "exactly one roll number was allocated",
      (await counterValue(universityRollCounterId(CURRENT_YEAR))) ===
        (verifyRollBefore ?? 0) + 1
    );
    check("exactly one audit event was recorded", (await eventCount(verifyNewId)) === 1);
    const verifyEvent = await EnrollmentEvent.collection.findOne({
      studentId: verifyNewId,
    });
    check(
      "the audit event records the verification-time assignment",
      verifyEvent?.action === "assigned_on_verification"
    );
    check(
      "the audit event records the generated identifiers",
      verifyEvent?.enrollmentNumber === verifiedEnrollment &&
        verifyEvent?.universityRollNumber === verifiedRoll
    );
    check(
      "the audit event records the authenticated admin",
      String(verifyEvent?.actorAdminId) === adminIdString
    );

    /* ── 10. Repeated verification is idempotent ───────────────────────── */
    section("10. Repeated verification allocates nothing");

    const repeatVerify = await api(
      `/api/admin/students/${verifyNewId}/review`,
      token,
      "POST",
      { action: "verify" }
    );
    check("a repeat verification succeeds (200)", repeatVerify.status === 200);
    check(
      "the repeat is reported as already verified",
      repeatVerify.json.alreadyVerified === true
    );
    check(
      "the repeat returns the same identifiers",
      (repeatVerify.json.student as { enrollmentNumber?: string } | undefined)
        ?.enrollmentNumber === verifiedEnrollment &&
        (repeatVerify.json.student as { universityRollNumber?: string } | undefined)
          ?.universityRollNumber === verifiedRoll
    );
    check(
      "the repeat allocated no enrollment number",
      (await counterValue(ENROLLMENT_COUNTER_ID)) === (verifyEnrollmentBefore ?? 0) + 1
    );
    check(
      "the repeat allocated no roll number",
      (await counterValue(universityRollCounterId(CURRENT_YEAR))) ===
        (verifyRollBefore ?? 0) + 1
    );
    check("the repeat created no second audit event", (await eventCount(verifyNewId)) === 1);
    const repeatedDoc = await rawStudent(verifyNewId);
    check(
      "the repeat appended no second review-history entry",
      Array.isArray(repeatedDoc?.reviewHistory) && repeatedDoc.reviewHistory.length === 1
    );

    const enrollAfterVerify = await api(
      `/api/admin/students/${verifyNewId}/enroll`,
      token,
      "POST"
    );
    check(
      "assigning identifiers to an approved, fully identified record is a no-op (200)",
      enrollAfterVerify.status === 200,
      enrollAfterVerify.text.slice(0, 120)
    );
    check(
      "the no-op is reported as already complete",
      enrollAfterVerify.json.alreadyEnrolled === true
    );
    check(
      "the no-op preserved both identifiers and allocated nothing",
      String((await rawStudent(verifyNewId))?.enrollmentNumber) === verifiedEnrollment &&
        String((await rawStudent(verifyNewId))?.universityRollNumber) === verifiedRoll &&
        (await counterValue(ENROLLMENT_COUNTER_ID)) === (verifyEnrollmentBefore ?? 0) + 1 &&
        (await counterValue(universityRollCounterId(CURRENT_YEAR))) ===
          (verifyRollBefore ?? 0) + 1 &&
        (await eventCount(verifyNewId)) === 1
    );

    /* ── 11. Verification refusals ────────────────────────────────────── */
    section("11. Verification refuses ineligible records and forged input");

    const verifyRefusals: [string, mongoose.Types.ObjectId, number][] = [
      ["a rejected application", verifyRejectedId, 409],
      ["a legacy record with no stored status", verifyLegacyId, 409],
      ["an approved record missing one identifier", verifyPartialId, 409],
    ];
    for (const [label, id, expected] of verifyRefusals) {
      const docBefore = await rawStudent(id);
      const res = await api(`/api/admin/students/${id}/review`, token, "POST", {
        action: "verify",
      });
      check(`${label} cannot be verified (${expected})`, res.status === expected, `${res.status}`);
      const docAfter = await rawStudent(id);
      check(
        `${label} was not modified at all`,
        JSON.stringify(docBefore) === JSON.stringify(docAfter)
      );
      check(`${label} got no audit event`, (await eventCount(id)) === 0);
    }
    check(
      "the already-issued identifier of the refused record was preserved",
      (await rawStudent(verifyPartialId))?.enrollmentNumber === "EN00095001"
    );

    const incompleteVerify = await api(
      `/api/admin/students/${verifyIncompleteId}/review`,
      token,
      "POST",
      { action: "verify" }
    );
    check(
      "an incomplete registration is refused (400)",
      incompleteVerify.status === 400,
      `${incompleteVerify.status}`
    );
    check(
      "the incomplete application was not modified",
      (await rawStudent(verifyIncompleteId))?.applicationStatus === "pending" &&
        (await rawStudent(verifyIncompleteId))?.enrollmentNumber === undefined
    );
    check("the incomplete application got no identifiers", (await eventCount(verifyIncompleteId)) === 0);

    const badVerifyId = await api("/api/admin/students/not-an-id/review", token, "POST", {
      action: "verify",
    });
    check("an invalid student id is rejected (400)", badVerifyId.status === 400);
    const unknownVerify = await api(
      `/api/admin/students/${new mongoose.Types.ObjectId().toString()}/review`,
      token,
      "POST",
      { action: "verify" }
    );
    check("an unknown student is 404", unknownVerify.status === 404);

    const deactivatedVerify = await api(
      `/api/admin/students/${verifyLockedId}/review`,
      inactiveAdminToken,
      "POST",
      { action: "verify" }
    );
    check(
      "a deactivated admin's valid token cannot verify (403)",
      deactivatedVerify.status === 403,
      `${deactivatedVerify.status}`
    );
    check(
      "the deactivated admin's call wrote nothing",
      (await rawStudent(verifyLockedId))?.applicationStatus === "pending" &&
        (await rawStudent(verifyLockedId))?.enrollmentNumber === undefined &&
        (await eventCount(verifyLockedId)) === 0
    );

    // A forged body can never contribute an identifier or a status value.
    const forgedVerify = await api(
      `/api/admin/students/${verifyForgedId}/review`,
      token,
      "POST",
      {
        action: "verify",
        applicationStatus: "enrolled",
        accountStatus: "locked",
        enrollmentNumber: "EN99999999",
        universityRollNumber: "MSU1999999999",
        verifiedBy: new mongoose.Types.ObjectId().toString(),
        verifiedAt: "2000-01-01T00:00:00.000Z",
        counter: { nextValue: 1 },
        sequence: 1,
        operationId: "forged",
      }
    );
    check("a forged verification body still succeeds (it is ignored)", forgedVerify.status === 200);
    const forgedVerifyDoc = await rawStudent(verifyForgedId);
    check(
      "the forged enrollment number was not stored",
      forgedVerifyDoc?.enrollmentNumber !== "EN99999999" &&
        ENROLLMENT_NUMBER_PATTERN.test(String(forgedVerifyDoc?.enrollmentNumber ?? ""))
    );
    check(
      "the forged roll number was not stored",
      forgedVerifyDoc?.universityRollNumber !== "MSU1999999999" &&
        UNIVERSITY_ROLL_NUMBER_PATTERN.test(String(forgedVerifyDoc?.universityRollNumber ?? ""))
    );
    check(
      "the forged account status was not stored",
      forgedVerifyDoc?.accountStatus === "active"
    );
    check("the forged verifiedBy was not stored", forgedVerifyDoc?.verifiedBy === adminIdString);
    check(
      "the forged timestamp was not stored",
      forgedVerifyDoc?.verifiedAt instanceof Date &&
        (forgedVerifyDoc?.verifiedAt as Date).getFullYear() >= CURRENT_YEAR
    );

    /* ── 12. A restricted account is never un-restricted by approval ──── */
    section("12. Approval never lifts an account restriction");

    const lockedVerify = await api(
      `/api/admin/students/${verifyLockedId}/review`,
      token,
      "POST",
      { action: "verify" }
    );
    check("a pending application with a LOCKED account can still be approved (200)", lockedVerify.status === 200, lockedVerify.text.slice(0, 120));
    const lockedVerifyDoc = await rawStudent(verifyLockedId);
    check(
      "the identifiers were assigned to the locked-account record",
      ENROLLMENT_NUMBER_PATTERN.test(String(lockedVerifyDoc?.enrollmentNumber ?? "")) &&
        UNIVERSITY_ROLL_NUMBER_PATTERN.test(String(lockedVerifyDoc?.universityRollNumber ?? ""))
    );
    check(
      "the LOCKED account status was preserved",
      lockedVerifyDoc?.accountStatus === "locked"
    );
    check(
      "the response does not claim the account was activated",
      lockedVerify.json.accountActivated === false
    );

    /*
     * Concurrent verification of the SAME pending application: one attempt must
     * win, every response must be safe (no 5xx), the identifier pair must be
     * unique and only ONE audit event may be written. On a transactional
     * deployment the loser rolls its counters back; on the standalone fallback
     * it may consume a value that is then never issued (a gap, never a
     * duplicate).
     */
    section("13. Concurrent verification of one application");

    const concurrentVerifyGlobalBefore = await counterValue(ENROLLMENT_COUNTER_ID);
    const concurrentVerifyRollBefore = await counterValue(
      universityRollCounterId(CURRENT_YEAR)
    );
    const [verifyRaceA, verifyRaceB] = await Promise.all([
      api(`/api/admin/students/${verifyConcurrentId}/review`, token, "POST", {
        action: "verify",
      }),
      api(`/api/admin/students/${verifyConcurrentId}/review`, token, "POST", {
        action: "verify",
      }),
    ]);
    check(
      "no concurrent verification returns a server error",
      [verifyRaceA, verifyRaceB].every((r) => r.status === 200 || r.status === 409),
      `${verifyRaceA.status}/${verifyRaceB.status}`
    );
    const verifyPairs = new Set(
      [verifyRaceA, verifyRaceB]
        .filter((r) => r.status === 200)
        .map((r) => {
          const student = r.json.student as
            | { enrollmentNumber?: string; universityRollNumber?: string }
            | undefined;
          return `${student?.enrollmentNumber}|${student?.universityRollNumber}`;
        })
    );
    check("at least one concurrent verification succeeds", verifyPairs.size >= 1);
    check("every successful response reports the same identifier pair", verifyPairs.size === 1);
    const concurrentVerifyDoc = await rawStudent(verifyConcurrentId);
    check(
      "the stored pair matches the reported pair",
      verifyPairs.has(
        `${concurrentVerifyDoc?.enrollmentNumber}|${concurrentVerifyDoc?.universityRollNumber}`
      )
    );
    check(
      "the concurrently verified record is approved with both identifiers",
      concurrentVerifyDoc?.applicationStatus === "verified" &&
        ENROLLMENT_NUMBER_PATTERN.test(String(concurrentVerifyDoc?.enrollmentNumber ?? "")) &&
        UNIVERSITY_ROLL_NUMBER_PATTERN.test(
          String(concurrentVerifyDoc?.universityRollNumber ?? "")
        )
    );
    check(
      "exactly one audit event was written for the racy record",
      (await eventCount(verifyConcurrentId)) === 1
    );
    const concurrentGlobalAfter = await counterValue(ENROLLMENT_COUNTER_ID);
    const concurrentRollAfter = await counterValue(universityRollCounterId(CURRENT_YEAR));
    check(
      transactionsSupported
        ? "concurrent verification consumed exactly one value from each sequence"
        : "concurrent verification issued one value and consumed at most two (standalone gap)",
      transactionsSupported
        ? concurrentGlobalAfter === (concurrentVerifyGlobalBefore ?? 0) + 1 &&
            concurrentRollAfter === (concurrentVerifyRollBefore ?? 0) + 1
        : (concurrentGlobalAfter ?? 0) <= (concurrentVerifyGlobalBefore ?? 0) + 2 &&
            (concurrentRollAfter ?? 0) <= (concurrentVerifyRollBefore ?? 0) + 2
    );

    /* ── 14. Isolation ─────────────────────────────────────────────────── */
    section("14. Isolation");

    check(
      "no other seeded student was modified",
      (await rawStudent(pendingId))?.applicationStatus === "pending" &&
        (await rawStudent(rejectedId))?.applicationStatus === "rejected" &&
        (await rawStudent(legacyId))?.applicationStatus === undefined
    );
    check(
      "the temporary admin password field was never touched",
      (await Admin.collection.findOne({ _id: seededAdminId }))?.password ===
        "unused-for-token-only"
    );
  } finally {
    /* ── Cleanup: only the exact documents created above ──────────────── */
    if (seededStudentIds.length > 0) {
      await EnrollmentEvent.collection.deleteMany({
        studentId: { $in: seededStudentIds },
      });
      const cleanup = await Student.collection.deleteMany({
        _id: { $in: seededStudentIds },
      });
      console.log(`\nCleaned up ${cleanup.deletedCount} temporary student(s).`);
    }
    const tempAdminIds = [seededAdminId, seededInactiveAdminId].filter(
      (id): id is mongoose.Types.ObjectId => id !== null
    );
    if (tempAdminIds.length > 0) {
      await Admin.collection.deleteMany({ _id: { $in: tempAdminIds } });
      console.log(`Cleaned up ${tempAdminIds.length} temporary admin(s).`);
    }

    for (const [id, value] of counterSnapshot) {
      if (value === null) {
        await CounterModel.deleteOne({ _id: id });
      } else {
        await CounterModel.updateOne(
          { _id: id },
          { $set: { nextValue: value } },
          { upsert: true }
        );
      }
    }
    console.log("Restored the identifier sequences this run touched.");

    const leftovers = await Student.collection.countDocuments({
      email: { $regex: /^codebuff-verify-/ },
    });
    check("no temporary verification student remains", leftovers === 0, `${leftovers} left`);
    const orphanEvents = await EnrollmentEvent.collection.countDocuments({
      studentId: { $in: seededStudentIds },
    });
    check("no temporary enrollment event remains", orphanEvents === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("Verification run failed:", error);
  process.exit(1);
});
