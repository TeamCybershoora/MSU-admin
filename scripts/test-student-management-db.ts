/**
 * End-to-end verification of Student Management (activate / deactivate /
 * permanent delete) over the real API.
 *
 * Seeds a temporary admin (for a token) plus temporary students in the
 * configured MongoDB database, exercises the endpoints, then deletes exactly
 * those seeded documents again.
 *
 * Safety:
 * - Temporary records use a random `codebuff-verify-<hex>-*@example.invalid`
 *   email address.
 * - Cleanup deletes ONLY the exact `_id`s created here — no existing student or
 *   admin is read, modified or deleted.
 * - No password, key or connection string is ever printed.
 * - No Result / Enquiry / ProgrammeStructure / Syllabus document is touched.
 *
 * Usage:
 *   npm run build
 *   npx next start -p 3099          # in another terminal
 *   npx tsx scripts/test-student-management-db.ts
 *
 * MACRO NOTE: this script writes to the configured database (temporary records
 * only) and must be run deliberately against a non-production database.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import crypto from "crypto";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Admin from "@/models/Admin";
import Student from "@/models/Student";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3099";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const suffix = crypto.randomBytes(6).toString("hex");
const tempEmails = {
  deletable: `codebuff-verify-${suffix}-delete@example.invalid`,
  toggled: `codebuff-verify-${suffix}-toggle@example.invalid`,
  legacy: `codebuff-verify-${suffix}-legacy@example.invalid`,
  missing: `codebuff-verify-${suffix}-missing@example.invalid`,
};
const tempAdminEmail = `codebuff-verify-${suffix}-admin@example.invalid`;

/** Ids created by this run — the only documents cleanup may remove. */
const seededStudentIds: mongoose.Types.ObjectId[] = [];
let seededAdminId: mongoose.Types.ObjectId | null = null;

let clientIp = "198.51.100.10";
function setClientIp(ip: string) {
  clientIp = ip;
}

async function api(
  path: string,
  token: string | null,
  method: "GET" | "PATCH" | "DELETE",
  body?: unknown
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": clientIp,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

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

async function main() {
  const { generateAdminToken } = await import("@/lib/auth-helpers");

  console.log(`Verifying against ${BASE} (temporary records, removed at the end)`);
  await connectDB();

  // ── Seed a temporary admin (only used to mint a valid token) ──────────────
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

  const token = generateAdminToken(String(seededAdminId), "admin");

  // ── Seed temporary students ──────────────────────────────────────────────
  const deletableId = (
    await Student.collection.insertOne({
      name: "Temp Deletable Student",
      email: tempEmails.deletable,
      username: "temp-deletable",
      password: "unused-for-verify",
      course: "BCA",
      aadhar: "999000000001",
      abcId: "VERIFYDEL0001".slice(0, 12),
      phone: "9000000001",
      college: "Verify College",
      profileImage: "",
      status: "ACTIVE",
      registeredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    })
  ).insertedId as mongoose.Types.ObjectId;

  const toggledId = (
    await Student.collection.insertOne({
      name: "Temp Toggled Student",
      email: tempEmails.toggled,
      username: "temp-toggled",
      password: "unused-for-verify",
      course: "BCA",
      aadhar: "999000000002",
      abcId: "VERIFYTOG0002".slice(0, 12),
      phone: "9000000002",
      college: "Verify College",
      profileImage: "",
      status: "ACTIVE",
      registeredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    })
  ).insertedId as mongoose.Types.ObjectId;

  // A legacy-shaped student: NO status field at all — must behave as ACTIVE.
  const legacyId = (
    await Student.collection.insertOne({
      name: "Temp Legacy Student",
      email: tempEmails.legacy,
      username: "temp-legacy",
      password: "unused-for-verify",
      course: "BCA",
      aadhar: "999000000003",
      abcId: "VERIFYLEG0003".slice(0, 12),
      phone: "9000000003",
      college: "Verify College",
      profileImage: "",
      registeredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    })
  ).insertedId as mongoose.Types.ObjectId;

  seededStudentIds.push(deletableId, toggledId, legacyId);

  const toggledBefore = await rawStudent(toggledId);

  try {
    /* ── Authorization ─────────────────────────────────────────────────── */
    section("Authorization");
    setClientIp("198.51.100.11");
    check("GET without a token is rejected", (await api("/api/admin/students", null, "GET")).status === 401);
    check(
      "PATCH without a token is rejected",
      (await api("/api/admin/students", null, "PATCH", { studentId: String(toggledId), status: "INACTIVE" })).status === 401
    );
    check(
      "DELETE without a token is rejected",
      (await api("/api/admin/students", null, "DELETE", { studentId: String(deletableId), confirmEmail: tempEmails.deletable })).status === 401
    );

    /* ── List + status filter ─────────────────────────────────────────── */
    section("List and status filter");
    setClientIp("198.51.100.12");

    const listed = await api(`/api/admin/students?search=${encodeURIComponent(tempEmails.toggled)}&limit=20`, token, "GET");
    const listedRows = (listed.json.data as { status?: string }[] | undefined) ?? [];
    check("search finds the student", listed.status === 200 && listedRows.length === 1);
    check("the list exposes the status field", listedRows[0]?.status === "ACTIVE");

    const activeOnly = await api(`/api/admin/students?status=ACTIVE&limit=100`, token, "GET");
    const activeEmails = ((activeOnly.json.data as { email: string }[] | undefined) ?? []).map((s) => s.email);
    check("ACTIVE filter includes an explicit ACTIVE student", activeEmails.includes(tempEmails.toggled));
    check("ACTIVE filter treats a legacy (no status) student as ACTIVE", activeEmails.includes(tempEmails.legacy));

    const inactiveOnly = await api(`/api/admin/students?status=INACTIVE&limit=100`, token, "GET");
    const inactiveEmails = ((inactiveOnly.json.data as { email: string }[] | undefined) ?? []).map((s) => s.email);
    check("INACTIVE filter excludes ACTIVE students", !inactiveEmails.includes(tempEmails.toggled));

    /* ── Activate / deactivate ────────────────────────────────────────── */
    section("Activate / deactivate");
    setClientIp("198.51.100.13");

    const badStatus = await api("/api/admin/students", token, "PATCH", { studentId: String(toggledId), status: "DELETED" });
    check("an unknown status is rejected (400)", badStatus.status === 400);

    const badId = await api("/api/admin/students", token, "PATCH", { studentId: "not-an-id", status: "INACTIVE" });
    check("an invalid id is rejected (400)", badId.status === 400);

    const missing = await api("/api/admin/students", token, "PATCH", {
      studentId: new mongoose.Types.ObjectId().toString(),
      status: "INACTIVE",
    });
    check("a nonexistent student is 404", missing.status === 404);

    const deactivate = await api("/api/admin/students", token, "PATCH", { studentId: String(toggledId), status: "INACTIVE" });
    check("deactivate succeeds (200)", deactivate.status === 200);

    const toggledAfter = await rawStudent(toggledId);
    check("the stored status is now INACTIVE", toggledAfter?.status === "INACTIVE");
    check(
      "deactivation left every other field unchanged",
      toggledAfter?.name === toggledBefore?.name &&
        toggledAfter?.email === toggledBefore?.email &&
        toggledAfter?.course === toggledBefore?.course &&
        toggledAfter?.college === toggledBefore?.college &&
        toggledAfter?.phone === toggledBefore?.phone
    );

    const activate = await api("/api/admin/students", token, "PATCH", { studentId: String(toggledId), status: "ACTIVE" });
    check("activate succeeds (200)", activate.status === 200);
    check("the stored status is ACTIVE again", (await rawStudent(toggledId))?.status === "ACTIVE");

    const repeated = await api("/api/admin/students", token, "PATCH", { studentId: String(toggledId), status: "ACTIVE" });
    check("setting the current status is an idempotent success (200)", repeated.status === 200);

    /* ── Hard delete ──────────────────────────────────────────────────── */
    section("Hard delete");
    setClientIp("198.51.100.14");

    const badConfirm = await api("/api/admin/students", token, "DELETE", {
      studentId: String(deletableId),
      confirmEmail: "wrong@example.invalid",
    });
    check("a wrong confirmation is rejected (400)", badConfirm.status === 400);
    check("the student still exists after a rejected delete", (await rawStudent(deletableId)) !== null);

    const badDeleteId = await api("/api/admin/students", token, "DELETE", {
      studentId: "not-an-id",
      confirmEmail: tempEmails.deletable,
    });
    check("an invalid id is rejected (400)", badDeleteId.status === 400);

    const missingDelete = await api("/api/admin/students", token, "DELETE", {
      studentId: new mongoose.Types.ObjectId().toString(),
      confirmEmail: tempEmails.deletable,
    });
    check("deleting a nonexistent student is 404", missingDelete.status === 404);

    const deleted = await api("/api/admin/students", token, "DELETE", {
      studentId: String(deletableId),
      confirmEmail: tempEmails.deletable.toUpperCase(), // case-insensitive on the server
    });
    check("a correct confirmation permanently deletes (200)", deleted.status === 200);
    check("the student document is gone", (await rawStudent(deletableId)) === null);

    setClientIp("198.51.100.15");
    const afterDelete = await api(`/api/admin/students?search=${encodeURIComponent(tempEmails.deletable)}`, token, "GET");
    const remaining = (afterDelete.json.data as unknown[] | undefined) ?? [];
    check("the deleted student no longer appears in the list", remaining.length === 0);

    /* ── Isolation ────────────────────────────────────────────────────── */
    section("Isolation");
    check("the other seeded student was not deleted", (await rawStudent(toggledId)) !== null);
    check("the legacy student was not deleted", (await rawStudent(legacyId)) !== null);
  } finally {
    /* ── Cleanup: only the exact documents created above ─────────────── */
    if (seededStudentIds.length > 0) {
      const cleanup = await Student.collection.deleteMany({
        _id: { $in: seededStudentIds },
      });
      console.log(`\nCleaned up ${cleanup.deletedCount} temporary student(s).`);
    }
    if (seededAdminId) {
      await Admin.collection.deleteMany({ _id: seededAdminId });
      console.log("Cleaned up the temporary admin.");
    }

    const leftovers = await Student.collection.countDocuments({
      email: { $regex: /^codebuff-verify-/ },
    });
    check("no temporary verification student remains", leftovers === 0, `${leftovers} left`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("Verification run failed:", error);
  try {
    if (seededStudentIds.length > 0) {
      await Student.collection.deleteMany({ _id: { $in: seededStudentIds } });
    }
    if (seededAdminId) {
      await Admin.collection.deleteMany({ _id: seededAdminId });
    }
    console.error("Temporary records cleaned up after failure.");
  } catch {
    console.error("Cleanup after failure also failed — check the temp records manually.");
  }
  process.exit(1);
});
