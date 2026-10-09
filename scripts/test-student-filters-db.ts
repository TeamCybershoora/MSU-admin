/**
 * End-to-end verification of the Student Management LIST FILTERS over the real
 * API (search, course, applicationStatus, account status, pagination).
 *
 * Seeds a temporary admin (for a token) plus temporary students covering every
 * application-status option, legacy/null/invalid stored statuses and both
 * account states, exercises GET /api/admin/students with each filter and
 * combination, then deletes exactly those seeded documents again.
 *
 * Safety:
 * - Temporary records use a random `codebuff-filter-<hex>-*@example.invalid`
 *   email address.
 * - Cleanup deletes ONLY the exact `_id`s created here — no existing student or
 *   admin is read, modified or deleted.
 * - No password, key or connection string is ever printed.
 * - Read assertions compare only ids/statuses of the seeded records; no other
 *   record's contents are read or displayed.
 * - No Result / Enquiry / ProgrammeStructure / Syllabus document is touched.
 *
 * Usage:
 *   npx next dev -p 3099          # or `npm run build` + `npx next start -p 3099`
 *   npx tsx scripts/test-student-filters-db.ts
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
const SFX = suffix; // search token: appears in every seeded username + email

/** Digit helper for unique phone/aadhar values within one run. */
const RUN_DIGITS = String(Date.now()).slice(-8);
function digits(idx: number, len: number): string {
  const base = `${RUN_DIGITS}${String(idx).padStart(2, "0")}`;
  return (base + "0".repeat(len)).slice(0, len);
}

type SeedSpec = {
  key: string;
  email: string;
  fields: Record<string, unknown>;
};

function seeds(): SeedSpec[] {
  const mk = (key: string, idx: number, fields: Record<string, unknown>): SeedSpec => ({
    key,
    email: `codebuff-filter-${suffix}-${key}@example.invalid`,
    fields: {
      name: `Temp Filter ${key}`,
      username: `flt-${suffix}-${key}`,
      password: "unused-for-filter-test",
      aadhar: digits(idx, 12),
      abcId: `f${suffix.slice(0, 9)}${String(idx).padStart(2, "0")}`.slice(0, 12),
      phone: digits(idx + 50, 10),
      college: "Filter Test College",
      profileImage: "",
      registeredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
      ...fields,
    },
  });

  return [
    mk("pending", 1, {
      applicationStatus: "pending",
      accountStatus: "pending",
      status: "ACTIVE",
      course: "BCA",
    }),
    mk("correction", 2, {
      applicationStatus: "needs_correction",
      accountStatus: "pending",
      status: "ACTIVE",
      course: "BCA",
    }),
    mk("verified", 3, {
      applicationStatus: "verified",
      accountStatus: "active",
      status: "ACTIVE",
      course: "B.Sc",
    }),
    // Rejected but the account row still reads Active — the reported shape.
    mk("rejected", 4, {
      applicationStatus: "rejected",
      accountStatus: "active",
      status: "ACTIVE",
      course: "BCA",
      rejectionReason: "temp filter test",
    }),
    mk("enrolled", 5, {
      applicationStatus: "enrolled",
      accountStatus: "active",
      status: "ACTIVE",
      course: "B.Sc",
      enrollmentNumber: `EN${digits(5, 8)}`,
      universityRollNumber: `MSU2024${digits(5, 6)}`,
      enrolledAt: new Date(),
      enrolledBy: "filter-test",
    }),
    mk("inactive", 6, {
      applicationStatus: "verified",
      accountStatus: "inactive",
      status: "INACTIVE",
      course: "B.Sc",
    }),
    // Legacy document: NO applicationStatus, NO accountStatus, NO status.
    mk("legacy", 7, {
      course: "BCA",
    }),
    // Explicit null applicationStatus (raw write) — must read as verified.
    mk("nullstatus", 8, {
      applicationStatus: null,
      status: "ACTIVE",
      course: "BCA",
    }),
    // Invalid stored applicationStatus (raw write bypasses the schema enum).
    // effectiveApplicationStatus() maps it to "verified" for display, so the
    // verified FILTER must map it the same way (filter == display).
    mk("invalid", 9, {
      applicationStatus: "Approved",
      status: "ACTIVE",
      course: "BCA",
    }),
  ];
}

type Row = {
  id: string;
  email: string;
  status?: string;
  applicationStatus?: string;
  accountStatus?: string;
  course?: string;
};

const seededStudentIds: mongoose.Types.ObjectId[] = [];
let seededAdminId: mongoose.Types.ObjectId | null = null;

let clientIp = "198.51.100.10";
function setClientIp(ip: string) {
  clientIp = ip;
}

async function api(path: string, token: string | null) {
  const headers: Record<string, string> = { "x-forwarded-for": clientIp };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

function rowsOf(json: Record<string, unknown>): Row[] {
  return (json.data as Row[] | undefined) ?? [];
}

function emailsOf(rows: Row[]): string[] {
  return rows.map((r) => r.email).sort();
}

function equalsSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((value, index) => value === e[index]);
}

async function main() {
  const { generateAdminToken } = await import("@/lib/auth-helpers");

  console.log(`Verifying student filters against ${BASE} (temporary records, removed at the end)`);
  await connectDB();

  /* ── Seed a temporary admin (only used to mint a valid token) ──────────── */
  seededAdminId = (
    await Admin.collection.insertOne({
      name: "Temp Filter Admin",
      email: `codebuff-filter-${suffix}-admin@example.invalid`,
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

  /* ── Seed the synthetic students ───────────────────────────────────────── */
  const byKey: Record<string, Row> = {};
  for (const [index, spec] of seeds().entries()) {
    const id = (
      await Student.collection.insertOne({
        ...spec.fields,
        email: spec.email,
      })
    ).insertedId as mongoose.Types.ObjectId;
    seededStudentIds.push(id);
    byKey[spec.key] = { id: String(id), email: spec.email };
  }

  const E = (key: string) => byKey[key].email;
  const ALL_KEYS = Object.keys(byKey);
  const ALL_EMAILS = ALL_KEYS.map(E);
  const search = `flt-${suffix}`; // matches every seeded record (username)

  try {
    /* ── Authorization ───────────────────────────────────────────────────── */
    section("Authorization");
    setClientIp("198.51.100.21");
    check(
      "GET without a token is rejected (401)",
      (await api("/api/admin/students?limit=1", null)).status === 401
    );

    /* ── Baseline: search returns every seeded record with correct display ─ */
    section("Baseline search (unfiltered) + status rendering");
    setClientIp("198.51.100.22");
    const base = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&limit=100`,
      token
    );
    const baseRows = rowsOf(base.json);
    check("search finds all seeded records", base.status === 200 && equalsSet(emailsOf(baseRows), ALL_EMAILS),
      `got ${baseRows.length}`);
    check(
      "pagination.total matches the returned set",
      (base.json.pagination as { total?: number } | undefined)?.total === ALL_KEYS.length
    );

    const expectedDisplay: Record<string, { app: string; account: string }> = {
      pending: { app: "pending", account: "ACTIVE" },
      correction: { app: "needs_correction", account: "ACTIVE" },
      verified: { app: "verified", account: "ACTIVE" },
      rejected: { app: "rejected", account: "ACTIVE" },
      enrolled: { app: "enrolled", account: "ACTIVE" },
      inactive: { app: "verified", account: "INACTIVE" },
      legacy: { app: "verified", account: "ACTIVE" },
      nullstatus: { app: "verified", account: "ACTIVE" },
      invalid: { app: "verified", account: "ACTIVE" },
    };
    for (const key of ALL_KEYS) {
      const row = baseRows.find((r) => r.email === E(key));
      check(
        `row "${key}" renders application=${expectedDisplay[key].app} account=${expectedDisplay[key].account}`,
        !!row && row.applicationStatus === expectedDisplay[key].app && row.status === expectedDisplay[key].account,
        row ? `got app=${row.applicationStatus} account=${row.status}` : "row missing"
      );
    }

    /* ── applicationStatus: every option (scoped by the unique search) ───── */
    section("applicationStatus filter (each option, backend-enforced)");
    setClientIp("198.51.100.23");

    const appCases: { value: string; expectedKeys: string[]; label: string }[] = [
      { value: "pending", expectedKeys: ["pending"], label: "pending returns only pending" },
      {
        value: "needs_correction",
        expectedKeys: ["correction"],
        label: "needs_correction returns only needs-correction",
      },
      {
        value: "verified",
        expectedKeys: ["verified", "inactive", "legacy", "nullstatus", "invalid"],
        label: "verified returns stored-verified + legacy/null/invalid (effective verified)",
      },
      {
        value: "rejected",
        expectedKeys: ["rejected"],
        label: "rejected returns ONLY rejected records (defect 4)",
      },
      {
        value: "enrolled",
        expectedKeys: ["enrolled"],
        label: "enrolled returns ONLY enrolled records (defect 1)",
      },
    ];

    for (const testCase of appCases) {
      const res = await api(
        `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=${testCase.value}&limit=100`,
        token
      );
      const rows = rowsOf(res.json);
      check(
        testCase.label,
        res.status === 200 && equalsSet(emailsOf(rows), testCase.expectedKeys.map(E)),
        `got [${emailsOf(rows).map((e) => e.split("-").pop()).join(", ")}]`
      );
      check(
        `every row under applicationStatus=${testCase.value} DISPLAYS that status`,
        rows.every((r) => r.applicationStatus === testCase.value),
        rows
          .filter((r) => r.applicationStatus !== testCase.value)
          .map((r) => `${r.email}:${r.applicationStatus}`)
          .join(", ")
      );
      check(
        `pagination.total under applicationStatus=${testCase.value} equals the row count`,
        (res.json.pagination as { total?: number } | undefined)?.total === testCase.expectedKeys.length
      );
    }

    // Reported defect 3 shape: the rows under "Verified" must not be reachable
    // from the pending queue — i.e. verified ∩ pending = ∅ (contradictory pair).
    const verifiedRows = rowsOf(
      (
        await api(
          `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=verified&limit=100`,
          token
        )
      ).json
    );
    check(
      "contradictory pair: no pending record appears under Verified (defect 3)",
      !verifiedRows.some((r) => r.email === E("pending") || r.email === E("correction"))
    );

    /* ── Invalid filter value: documented family convention ──────────────── */
    section("Invalid applicationStatus value (parameter validation)");
    setClientIp("198.51.100.24");
    const invalidParam = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=unverified&limit=100`,
      token
    );
    // Documented contract (route doc comment): omitted/invalid = ALL.
    check(
      "an unknown applicationStatus value behaves as ALL (documented convention)",
      invalidParam.status === 200 && equalsSet(emailsOf(rowsOf(invalidParam.json)), ALL_EMAILS),
      `got ${(rowsOf(invalidParam.json) ?? []).length} rows`
    );

    /* ── Account status filter ───────────────────────────────────────────── */
    section("Account status filter (ACTIVE / INACTIVE)");
    setClientIp("198.51.100.25");
    const active = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&status=ACTIVE&limit=100`,
      token
    );
    const activeEmails = emailsOf(rowsOf(active.json));
    check(
      "ACTIVE returns every explicit-ACTIVE record",
      ALL_KEYS.filter((k) => k !== "inactive").every((k) => activeEmails.includes(E(k)))
    );
    check(
      "ACTIVE treats the legacy (no status) record as ACTIVE",
      activeEmails.includes(E("legacy"))
    );
    check("ACTIVE excludes the INACTIVE record", !activeEmails.includes(E("inactive")));

    const inactive = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&status=INACTIVE&limit=100`,
      token
    );
    check(
      "INACTIVE returns exactly the INACTIVE record",
      equalsSet(emailsOf(rowsOf(inactive.json)), [E("inactive")])
    );

    /* ── Course filter ───────────────────────────────────────────────────── */
    section("Course filter");
    setClientIp("198.51.100.26");
    const bca = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&course=${encodeURIComponent("BCA")}&limit=100`,
      token
    );
    check(
      "course=BCA returns exactly the BCA records",
      equalsSet(
        emailsOf(rowsOf(bca.json)),
        ["pending", "correction", "rejected", "legacy", "nullstatus", "invalid"].map(E)
      )
    );
    const bsc = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&course=${encodeURIComponent("B.Sc")}&limit=100`,
      token
    );
    check(
      "course=B.Sc returns exactly the B.Sc records",
      equalsSet(emailsOf(rowsOf(bsc.json)), ["verified", "enrolled", "inactive"].map(E))
    );

    /* ── Combined filters ────────────────────────────────────────────────── */
    section("Combined filters and contradictions");
    setClientIp("198.51.100.27");
    const combined = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=verified&status=INACTIVE&course=${encodeURIComponent("B.Sc")}&limit=100`,
      token
    );
    check(
      "verified + INACTIVE + B.Sc returns exactly the one matching record",
      equalsSet(emailsOf(rowsOf(combined.json)), [E("inactive")])
    );

    const contradiction = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=pending&status=INACTIVE&limit=100`,
      token
    );
    check(
      "pending + INACTIVE is a valid empty result (200, total 0, no rows)",
      contradiction.status === 200 &&
        rowsOf(contradiction.json).length === 0 &&
        (contradiction.json.pagination as { total?: number } | undefined)?.total === 0
    );

    const searchMiss = await api(
      `/api/admin/students?search=definitely-not-a-student-${suffix}&applicationStatus=verified&limit=100`,
      token
    );
    check(
      "search with no matches under a status filter is an empty result (200, total 0)",
      searchMiss.status === 200 &&
        rowsOf(searchMiss.json).length === 0 &&
        (searchMiss.json.pagination as { total?: number } | undefined)?.total === 0
    );

    /* ── Pagination + count consistency under a filter ───────────────────── */
    section("Pagination consistency under a filter");
    setClientIp("198.51.100.28");
    const verifiedExpected = ["verified", "inactive", "legacy", "nullstatus", "invalid"].map(E);
    const p1 = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=verified&limit=2&page=1`,
      token
    );
    const p2 = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=verified&limit=2&page=2`,
      token
    );
    const p3 = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=verified&limit=2&page=3`,
      token
    );
    const pRows = [...rowsOf(p1.json), ...rowsOf(p2.json), ...rowsOf(p3.json)];
    check(
      "pages partition the filtered set (no duplicates, no gaps)",
      equalsSet(emailsOf(pRows), verifiedExpected) && pRows.length === verifiedExpected.length
    );
    check(
      "every page reports the same filtered total",
      [p1, p2, p3].every(
        (page) => (page.json.pagination as { total?: number } | undefined)?.total === verifiedExpected.length
      )
    );
    check(
      "totalPages reflects the filtered total (5 rows / limit 2 = 3 pages)",
      (p1.json.pagination as { totalPages?: number } | undefined)?.totalPages === 3
    );
    const p4 = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&applicationStatus=verified&limit=2&page=4`,
      token
    );
    check(
      "a page beyond the end returns rows=[] with the filtered total intact",
      rowsOf(p4.json).length === 0 &&
        (p4.json.pagination as { total?: number } | undefined)?.total === verifiedExpected.length
    );

    /* ── Filter reset restores the unfiltered set ────────────────────────── */
    section("Filter reset");
    setClientIp("198.51.100.29");
    const reset = await api(
      `/api/admin/students?search=${encodeURIComponent(search)}&limit=100`,
      token
    );
    check(
      "clearing every filter restores the full seeded set",
      equalsSet(emailsOf(rowsOf(reset.json)), ALL_EMAILS)
    );
  } finally {
    /* ── Cleanup: only the exact documents created above ─────────────────── */
    if (seededStudentIds.length > 0) {
      const cleanup = await Student.collection.deleteMany({ _id: { $in: seededStudentIds } });
      console.log(`\nCleaned up ${cleanup.deletedCount} temporary student(s).`);
    }
    if (seededAdminId) {
      await Admin.collection.deleteMany({ _id: seededAdminId });
      console.log("Cleaned up the temporary admin.");
    }

    const leftovers = await Student.collection.countDocuments({
      email: { $regex: /^codebuff-filter-/ },
    });
    check("no temporary filter-test student remains", leftovers === 0, `${leftovers} left`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("Filter verification run failed:", error);
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
