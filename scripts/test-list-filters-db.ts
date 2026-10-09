/**
 * End-to-end verification of the LIST FILTERS on every other filtered admin
 * page (Results, Notices, News, Colleges, Recruitment, Academic Structure,
 * Enquiries, Syllabus) over the real API.
 *
 * For each route this script asserts, per filter option:
 *   (a) ENFORCEMENT — every row returned under an option actually matches that
 *       option (the backend filters; nothing is hidden only in the UI), and a
 *       search-scoped query returns exactly the seeded set,
 *   (b) EXPECTED-EMPTY and invalid-value behaviour is pinned,
 *   (c) COUNT CONSISTENCY — pagination.total equals the scoped row count,
 *   (d) UNAUTHORISED requests are rejected (spot-checked per route).
 *
 * Safety:
 * - Temporary records use a random `codebuff-list-<hex>` token in every
 *   searchable field, and cleanup deletes ONLY the exact `_id`s created here.
 * - No password, key or connection string is ever printed; assertions read only
 *   the seeded records' ids/statuses.
 *
 * Usage:
 *   npx next dev -p 3099          # or `npm run build` + `npx next start -p 3099`
 *   npx tsx scripts/test-list-filters-db.ts
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
import Result from "@/models/Result";
import Notice from "@/models/Notice";
import News from "@/models/News";
import College from "@/models/College";
import Recruitment from "@/models/Recruitment";
import ProgrammeStructure from "@/models/ProgrammeStructure";
import Enquiry from "@/models/Enquiry";
import Syllabus from "@/models/Syllabus";
import { NOTICE_CATEGORIES, VALID_CONTENT_TYPES } from "@/lib/notice-types";
import { NEWS_STATUSES } from "@/lib/news-types";
import { STRUCTURE_STATUSES } from "@/lib/programme-structure";
import { ENQUIRY_STATUSES, ENQUIRY_TYPES, GENERAL_INQUIRY_TYPES } from "@/lib/enquiry-types";

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
const TOKEN = `codebuff-list-${suffix}`;

/** Ids created by this run — the only documents cleanup may remove. */
const seeded: { label: string; model: { collection: mongoose.Collection }; id: mongoose.Types.ObjectId }[] = [];
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

type Row = Record<string, unknown>;

function rowsOf(json: Record<string, unknown>): Row[] {
  return (json.data as Row[] | undefined) ?? [];
}

function totalOf(json: Record<string, unknown>): number | undefined {
  return (json.pagination as { total?: number } | undefined)?.total;
}

async function seed(
  label: string,
  model: { collection: mongoose.Collection },
  doc: Record<string, unknown>
): Promise<string> {
  const id = (await model.collection.insertOne(doc)).insertedId as mongoose.Types.ObjectId;
  seeded.push({ label, model, id });
  return String(id);
}

async function main() {
  const { generateAdminToken } = await import("@/lib/auth-helpers");

  console.log(`Verifying list filters against ${BASE} (temporary records, removed at the end)`);
  await connectDB();

  seededAdminId = (
    await Admin.collection.insertOne({
      name: "Temp List-Filter Admin",
      email: `codebuff-list-${suffix}-admin@example.invalid`,
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
  const NOW = new Date("2026-01-05T10:00:00.000Z"); // identical instants on purpose (tie-break coverage)

  try {
    /* ══ Results ════════════════════════════════════════════════════════ */
    section("Results — search, status PASS/FAIL, counts");
    setClientIp("198.51.100.31");
    const passId = await seed("result-pass", Result, {
      student: { name: `Temp Pass ${suffix}`, rollNumber: `RL${suffix}`.slice(0, 10), enrollmentNumber: `EN${suffix}`.slice(0, 10), course: "BCA", semester: 1 },
      subjects: [], totalMarks: 50, maxTotalMarks: 100, percentage: 50,
      sgpa: null, cgpa: 7.1, equivalentPercentage: 68, resultStatus: "PASS",
      remarks: "", declaredDate: NOW, createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    const failId = await seed("result-fail", Result, {
      student: { name: `Temp Fail ${suffix}`, rollNumber: `RF${suffix}`.slice(0, 10), enrollmentNumber: `EF${suffix}`.slice(0, 10), course: "BCA", semester: 1 },
      subjects: [], totalMarks: 20, maxTotalMarks: 100, percentage: 20,
      sgpa: null, cgpa: 0, equivalentPercentage: 0, resultStatus: "FAIL",
      remarks: "", declaredDate: NOW, createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    check("GET without a token is rejected (401)", (await api("/api/admin/results?limit=1", null)).status === 401);

    const rAll = await api(`/api/admin/results?search=${encodeURIComponent(suffix)}&limit=100`, token);
    check("results search finds both seeded records", rAll.status === 200 && rowsOf(rAll.json).length === 2,
      `got ${rowsOf(rAll.json).length}`);
    check("results pagination.total matches the scoped set", totalOf(rAll.json) === 2);

    const rPass = await api(`/api/admin/results?search=${encodeURIComponent(suffix)}&status=PASS&limit=100`, token);
    check("status=PASS returns exactly the PASS record",
      rPass.status === 200 && rowsOf(rPass.json).length === 1 && rowsOf(rPass.json)[0]?.student !== undefined &&
      JSON.stringify(rowsOf(rPass.json)[0]?.student).includes(suffix),
      `got ${rowsOf(rPass.json).length}`);
    const rPassAll = await api(`/api/admin/results?status=PASS&limit=100`, token);
    check("status=PASS enforcement: every returned row is PASS",
      rPassAll.status === 200 && rowsOf(rPassAll.json).every((r) => r.resultStatus === "PASS"));

    const rFail = await api(`/api/admin/results?search=${encodeURIComponent(suffix)}&status=FAIL&limit=100`, token);
    check("status=FAIL returns exactly the FAIL record", rFail.status === 200 && rowsOf(rFail.json).length === 1);
    const rBogus = await api(`/api/admin/results?search=${encodeURIComponent(suffix)}&status=BOGUS&limit=100`, token);
    check("an unknown status value returns an empty result (exact-match semantics)",
      rBogus.status === 200 && rowsOf(rBogus.json).length === 0 && totalOf(rBogus.json) === 0);
    const rPage = await api(`/api/admin/results?search=${encodeURIComponent(suffix)}&status=PASS&limit=1&page=1`, token);
    check("results pagination.total is the filtered total on a limited page", totalOf(rPage.json) === 1);

    /* ══ Notices ════════════════════════════════════════════════════════ */
    section("Notices — search, status, contentType, category, counts");
    setClientIp("198.51.100.32");
    const cat1 = NOTICE_CATEGORIES[0];
    const cat2 = NOTICE_CATEGORIES[1] ?? NOTICE_CATEGORIES[0];
    const noticePubId = await seed("notice-published", Notice, {
      title: `Temp Notice Published ${suffix}`, summary: "temp", content: "temp",
      category: cat1, contentType: VALID_CONTENT_TYPES[0], status: "published",
      publishedDate: NOW, isDeleted: false, isNewNotice: false, isImportant: false,
      attachmentName: "", attachmentUrl: "", imageId: "", imageAlt: "",
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    const noticeDraftId = await seed("notice-draft", Notice, {
      title: `Temp Notice Draft ${suffix}`, summary: "temp", content: "temp",
      category: cat2, contentType: VALID_CONTENT_TYPES[1] ?? VALID_CONTENT_TYPES[0], status: "draft",
      publishedDate: NOW, isDeleted: false, isNewNotice: false, isImportant: false,
      attachmentName: "", attachmentUrl: "", imageId: "", imageAlt: "",
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    // Legacy shape: NO contentType — must render AND filter as "notice".
    const noticeLegacyId = await seed("notice-legacy", Notice, {
      title: `Temp Notice Legacy ${suffix}`, summary: "temp", content: "temp",
      category: cat1, status: "published",
      publishedDate: NOW, isDeleted: false, isNewNotice: false, isImportant: false,
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    check("GET without a token is rejected (401)", (await api("/api/admin/notices?limit=1", null)).status === 401);

    const nAll = await api(`/api/admin/notices?search=${encodeURIComponent(suffix)}&limit=100`, token);
    check("notices search finds all three seeded notices", nAll.status === 200 && rowsOf(nAll.json).length === 3,
      `got ${rowsOf(nAll.json).length}`);
    check("notices pagination.total matches the scoped set", totalOf(nAll.json) === 3);

    const nPub = await api(`/api/admin/notices?search=${encodeURIComponent(suffix)}&status=published&limit=100`, token);
    check("status=published returns the two published notices",
      nPub.status === 200 && rowsOf(nPub.json).length === 2 && rowsOf(nPub.json).every((r) => r.status === "published"));
    const nDraft = await api(`/api/admin/notices?search=${encodeURIComponent(suffix)}&status=draft&limit=100`, token);
    check("status=draft returns exactly the draft notice",
      nDraft.status === 200 && rowsOf(nDraft.json).length === 1 && rowsOf(nDraft.json)[0]?.id === noticeDraftId);
    const nPubAll = await api(`/api/admin/notices?status=published&limit=100`, token);
    check("status=published enforcement: every returned row is published",
      nPubAll.status === 200 && rowsOf(nPubAll.json).every((r) => r.status === "published"));

    const nType = await api(
      `/api/admin/notices?search=${encodeURIComponent(suffix)}&contentType=${encodeURIComponent(VALID_CONTENT_TYPES[0])}&limit=100`,
      token
    );
    check(
      `contentType=${VALID_CONTENT_TYPES[0]} returns only that type (legacy-missing rows render as notice)`,
      nType.status === 200 &&
        rowsOf(nType.json).every((r) => (r.contentType || "notice") === VALID_CONTENT_TYPES[0]) &&
        rowsOf(nType.json).some((r) => r.id === noticeLegacyId),
      `got ${rowsOf(nType.json).length}`
    );
    const nCat = await api(
      `/api/admin/notices?search=${encodeURIComponent(suffix)}&category=${encodeURIComponent(cat1)}&limit=100`,
      token
    );
    check(`category filter returns only ${cat1} notices`,
      nCat.status === 200 && rowsOf(nCat.json).every((r) => r.category === cat1));
    const nBogus = await api(`/api/admin/notices?search=${encodeURIComponent(suffix)}&status=BOGUS&limit=100`, token);
    check("an unknown notice status behaves as no filter (documented family convention)",
      nBogus.status === 200 && rowsOf(nBogus.json).length === 3);
    void noticePubId;

    /* ══ News ═══════════════════════════════════════════════════════════ */
    section("News — search, status, counts");
    setClientIp("198.51.100.33");
    const newsPubId = await seed("news-published", News, {
      title: `Temp News Published ${suffix}`, summary: "temp", content: "temp",
      publishedDate: NOW, status: "published", isDeleted: false,
      imageId: "", imageName: "", imageAlt: "",
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    await seed("news-draft", News, {
      title: `Temp News Draft ${suffix}`, summary: "temp", content: "temp",
      publishedDate: NOW, status: "draft", isDeleted: false,
      imageId: "", imageName: "", imageAlt: "",
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    check("GET without a token is rejected (401)", (await api("/api/admin/news?limit=1", null)).status === 401);

    const wAll = await api(`/api/admin/news?search=${encodeURIComponent(suffix)}&limit=100`, token);
    check("news search finds both seeded items", wAll.status === 200 && rowsOf(wAll.json).length === 2);
    for (const status of NEWS_STATUSES) {
      const res = await api(
        `/api/admin/news?search=${encodeURIComponent(suffix)}&status=${status}&limit=100`,
        token
      );
      check(`news status=${status} returns only ${status} rows`,
        res.status === 200 && rowsOf(res.json).every((r) => r.status === status) && rowsOf(res.json).length >= 1);
    }
    const wDraft = await api(`/api/admin/news?search=${encodeURIComponent(suffix)}&status=draft&limit=100`, token);
    check("news status=draft scoped total is exact", totalOf(wDraft.json) === 1);
    void newsPubId;

    /* ══ Colleges ═══════════════════════════════════════════════════════ */
    section("Colleges — search, district, counts");
    setClientIp("198.51.100.34");
    await seed("college-saharanpur", College, {
      collegeName: `Temp College Saharanpur ${suffix}`, collegeCode: `TC${suffix}`.slice(0, 8).toUpperCase(),
      district: "Saharanpur", createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    await seed("college-shamli", College, {
      collegeName: `Temp College Shamli ${suffix}`, collegeCode: `TS${suffix}`.slice(0, 8).toUpperCase(),
      district: "Shamli", createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    check("GET without a token is rejected (401)", (await api("/api/admin/colleges?limit=1", null)).status === 401);

    const cAll = await api(`/api/admin/colleges?search=${encodeURIComponent(suffix)}&limit=100`, token);
    check("college search finds both seeded colleges", cAll.status === 200 && rowsOf(cAll.json).length === 2);
    const cDistrict = await api(
      `/api/admin/colleges?search=${encodeURIComponent(suffix)}&district=Saharanpur&limit=100`,
      token
    );
    check("district filter returns only the Saharanpur college",
      cDistrict.status === 200 && rowsOf(cDistrict.json).length === 1 &&
      rowsOf(cDistrict.json).every((r) => r.district === "Saharanpur"));
    const cDistrictAll = await api(`/api/admin/colleges?district=Shamli&limit=100`, token);
    check("district enforcement: every returned row is Shamli",
      cDistrictAll.status === 200 && rowsOf(cDistrictAll.json).every((r) => r.district === "Shamli"));

    /* ══ Recruitment ════════════════════════════════════════════════════ */
    section("Recruitment — type, status, search, counts");
    setClientIp("198.51.100.35");
    await seed("recruitment-job", Recruitment, {
      type: "job-opening", title: `Temp Recruitment Job ${suffix}`, description: "temp",
      publishedDate: NOW, documentUrl: "", documentName: "", status: "published",
      displayOrder: 0, isDeleted: false, createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    await seed("recruitment-order", Recruitment, {
      type: "government-order", title: `Temp Recruitment Order ${suffix}`, description: "temp",
      publishedDate: NOW, documentUrl: "", documentName: "", status: "draft",
      displayOrder: 1, isDeleted: false, createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    check("GET without a token is rejected (401)", (await api("/api/admin/recruitment?limit=1", null)).status === 401);

    const jJobs = await api(
      `/api/admin/recruitment?type=job-opening&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("type=job-opening returns only job openings",
      jJobs.status === 200 && rowsOf(jJobs.json).length === 1 && rowsOf(jJobs.json).every((r) => r.type === "job-opening"));
    const jOrders = await api(
      `/api/admin/recruitment?type=government-order&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("type=government-order returns only government orders",
      jOrders.status === 200 && rowsOf(jOrders.json).length === 1 && rowsOf(jOrders.json).every((r) => r.type === "government-order"));
    const jPub = await api(
      `/api/admin/recruitment?status=published&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("status=published returns only published rows",
      jPub.status === 200 && rowsOf(jPub.json).every((r) => r.status === "published"));
    const jDraft = await api(
      `/api/admin/recruitment?status=draft&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("status=draft returns only draft rows",
      jDraft.status === 200 && rowsOf(jDraft.json).every((r) => r.status === "draft") && rowsOf(jDraft.json).length === 1);
    const jBadType = await api(`/api/admin/recruitment?type=bogus-section`, token);
    check("an unknown type is rejected (400) — no silent unfiltered list", jBadType.status === 400);
    const jBadStatus = await api(`/api/admin/recruitment?status=bogus`, token);
    check("an unknown status is rejected (400) — no silent unfiltered list", jBadStatus.status === 400);

    /* ══ Academic Structure ═════════════════════════════════════════════ */
    section("Academic Structure — search, status, counts");
    setClientIp("198.51.100.36");
    const codeActive = `ZZA${suffix}`.toUpperCase().slice(0, 10);
    const codeInactive = `ZZB${suffix}`.toUpperCase().slice(0, 10);
    await seed("structure-active", ProgrammeStructure, {
      programmeCode: codeActive, programmeName: `Temp Programme Active ${suffix}`,
      academicSession: "2025-26", status: "ACTIVE", semesters: [],
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    await seed("structure-inactive", ProgrammeStructure, {
      programmeCode: codeInactive, programmeName: `Temp Programme Inactive ${suffix}`,
      academicSession: "2025-26", status: "INACTIVE", semesters: [],
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    const aActive = await api(
      `/api/admin/academic-structure?search=${encodeURIComponent(suffix)}&status=ACTIVE&limit=100`,
      token
    );
    check("status=ACTIVE returns only ACTIVE structures",
      aActive.status === 200 && rowsOf(aActive.json).length === 1 &&
      rowsOf(aActive.json).every((r) => r.status === "ACTIVE"));
    const aInactive = await api(
      `/api/admin/academic-structure?search=${encodeURIComponent(suffix)}&status=INACTIVE&limit=100`,
      token
    );
    check("status=INACTIVE returns only INACTIVE structures",
      aInactive.status === 200 && rowsOf(aInactive.json).length === 1 &&
      rowsOf(aInactive.json).every((r) => r.status === "INACTIVE"));
    const aAll = await api(`/api/admin/academic-structure?search=${encodeURIComponent(suffix)}&limit=100`, token);
    check("clearing the status filter returns both structures", aAll.status === 200 && rowsOf(aAll.json).length === 2);
    check("academic-structure pagination.total matches the scoped set", totalOf(aAll.json) === 2);

    /* ══ Enquiries (admission / affiliation / general) ═══════════════════ */
    section("Enquiries — fixed type, status, inquiryType, classification, search");
    setClientIp("198.51.100.37");
    const generalStatus = ENQUIRY_STATUSES[0];
    await seed("enquiry-admission-new", Enquiry, {
      reference: `FT-ADM-${suffix}`.toUpperCase().slice(0, 24), type: "admission", status: generalStatus,
      email: `codebuff-list-${suffix}-a@example.invalid`, phone: "9000000001",
      message: `temp enquiry ${suffix}`, fullName: `Temp Enquiry Admission ${suffix}`,
      course: "BCA", session: "2025-26", createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    const affiliationStatus = ENQUIRY_STATUSES[ENQUIRY_STATUSES.length - 1];
    await seed("enquiry-affiliation", Enquiry, {
      reference: `FT-AFF-${suffix}`.toUpperCase().slice(0, 24), type: "affiliation", status: affiliationStatus,
      email: `codebuff-list-${suffix}-b@example.invalid`, phone: "9000000002",
      message: `temp enquiry ${suffix}`, contactPerson: `Temp Enquiry Affiliation ${suffix}`,
      collegeName: `Temp College ${suffix}`, createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    const generalInquiryType: string = GENERAL_INQUIRY_TYPES[0];
    await seed("enquiry-general", Enquiry, {
      reference: `FT-GEN-${suffix}`.toUpperCase().slice(0, 24), type: "general", status: generalStatus,
      email: `codebuff-list-${suffix}-c@example.invalid`, phone: "9000000003",
      message: `temp general enquiry ${suffix}`, inquiryType: generalInquiryType,
      generalClassification: "", createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    check("GET without a token is rejected (401)", (await api("/api/admin/enquiries?limit=1", null)).status === 401);

    // The type parameter is ALWAYS sent by every enquiry page (fixedType).
    const eAdm = await api(
      `/api/admin/enquiries?type=admission&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("type=admission returns only admission enquiries",
      eAdm.status === 200 && rowsOf(eAdm.json).length === 1 && rowsOf(eAdm.json).every((r) => r.type === "admission"));
    const eAff = await api(
      `/api/admin/enquiries?type=affiliation&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("type=affiliation returns only affiliation enquiries",
      eAff.status === 200 && rowsOf(eAff.json).length === 1 && rowsOf(eAff.json).every((r) => r.type === "affiliation"));
    const eGen = await api(
      `/api/admin/enquiries?type=general&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("type=general returns only general enquiries",
      eGen.status === 200 && rowsOf(eGen.json).length === 1 && rowsOf(eGen.json).every((r) => r.type === "general"));

    const eStatus = await api(
      `/api/admin/enquiries?type=admission&status=${generalStatus}&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check(`status=${generalStatus} enforcement: every returned row matches`,
      eStatus.status === 200 && rowsOf(eStatus.json).every((r) => r.status === generalStatus));
    const eStatusOther = await api(
      `/api/admin/enquiries?type=admission&status=${affiliationStatus}&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("a mismatched status under the admission type is an empty result",
      eStatusOther.status === 200 && rowsOf(eStatusOther.json).length === 0 && totalOf(eStatusOther.json) === 0);

    const eInquiry = await api(
      `/api/admin/enquiries?type=general&inquiryType=${generalInquiryType}&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("inquiryType filter returns only matching general enquiries",
      eInquiry.status === 200 && rowsOf(eInquiry.json).length === 1 &&
      rowsOf(eInquiry.json).every((r) => r.inquiryType === generalInquiryType));
    const eUnclassified = await api(
      `/api/admin/enquiries?type=general&classification=unclassified&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("classification=unclassified selects the record with no saved classification",
      eUnclassified.status === 200 && rowsOf(eUnclassified.json).length === 1 &&
      rowsOf(eUnclassified.json).every((r) => r.classification === ""));
    const eInquiryBad = await api(
      `/api/admin/enquiries?type=general&inquiryType=$ne;anything&search=${encodeURIComponent(suffix)}&limit=100`,
      token
    );
    check("an unknown inquiryType means no filter — raw text never enters the query (200, no 500)",
      eInquiryBad.status === 200 && rowsOf(eInquiryBad.json).length === 1 &&
      rowsOf(eInquiryBad.json).every((r) => r.type === "general"));

    for (const enquiryType of ENQUIRY_TYPES) {
      const res = await api(
        `/api/admin/enquiries?type=${enquiryType}&search=${encodeURIComponent(suffix)}&limit=100`,
        token
      );
      check(`scoped list for type=${enquiryType} returns only that type`,
        res.status === 200 && rowsOf(res.json).every((r) => r.type === enquiryType));
    }

    /* ══ Syllabus ═══════════════════════════════════════════════════════ */
    section("Syllabus — search, programme, semester, counts");
    setClientIp("198.51.100.38");
    const prog1 = `ZZS${suffix}`.toUpperCase().slice(0, 8);
    const prog2 = `ZZT${suffix}`.toUpperCase().slice(0, 8);
    await seed("syllabus-1", Syllabus, {
      programme: prog1, academicSession: "2025-26", semester: 1,
      subjects: [{ subjectCode: `${prog1}101`, subjectName: `Temp Subject One ${suffix}`, maxMarks: 100, credits: 4 }],
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });
    await seed("syllabus-2", Syllabus, {
      programme: prog2, academicSession: "2025-26", semester: 2,
      subjects: [{ subjectCode: `${prog2}201`, subjectName: `Temp Subject Two ${suffix}`, maxMarks: 100, credits: 4 }],
      createdAt: NOW, updatedAt: NOW, __v: 0,
    });

    const sProg = await api(`/api/admin/syllabus?programme=${prog1}&limit=100`, token);
    check("programme filter returns only that programme",
      sProg.status === 200 && rowsOf(sProg.json).length === 1 && rowsOf(sProg.json).every((r) => r.programme === prog1));
    const sSem = await api(`/api/admin/syllabus?programme=${prog2}&semester=2&limit=100`, token);
    check("semester filter narrows to that semester",
      sSem.status === 200 && rowsOf(sSem.json).length === 1 && rowsOf(sSem.json).every((r) => r.semester === 2));
    const sSearch = await api(
      `/api/admin/syllabus?search=${encodeURIComponent(`Temp Subject Two ${suffix}`)}&limit=100`,
      token
    );
    check("subject-name search finds only the matching syllabus",
      sSearch.status === 200 && rowsOf(sSearch.json).length === 1 &&
      rowsOf(sSearch.json).every((r) => r.programme === prog2));
    const sReset = await api(`/api/admin/syllabus?search=${encodeURIComponent(suffix)}&limit=100`, token);
    check("clearing programme/semester restores every seeded syllabus",
      sReset.status === 200 && rowsOf(sReset.json).length === 2 && totalOf(sReset.json) === 2);
  } finally {
    /* ── Cleanup: only the exact documents created above ─────────────────── */
    let cleaned = 0;
    for (const entry of seeded) {
      const res = await entry.model.collection.deleteOne({ _id: entry.id });
      if (res.deletedCount) cleaned += 1;
    }
    console.log(`\nCleaned up ${cleaned} temporary record(s).`);
    if (seededAdminId) {
      await Admin.collection.deleteMany({ _id: seededAdminId });
      console.log("Cleaned up the temporary admin.");
    }

    const leftovers = await Promise.all(
      seeded.map((entry) => entry.model.collection.countDocuments({ _id: entry.id }))
    );
    check("no temporary list-filter record remains", leftovers.every((n) => n === 0));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("List-filter verification run failed:", error);
  try {
    for (const entry of seeded) {
      await entry.model.collection.deleteOne({ _id: entry.id });
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
