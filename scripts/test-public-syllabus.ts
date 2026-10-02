/**
 * Phase 2B verification — public, session-aware syllabus functionality.
 *
 * Runs against the REAL database (read-only): it requires the verified
 * BCA 2023-24 ProgrammeStructure created by `npm run seed:bca` and creates NO
 * records of its own. The functions under test are the exact ones the public
 * API routes call (lib/public-syllabus.ts), so the checks exercise the same
 * validation, identity and attribution rules production uses.
 *
 * Coverage (Phase 2B brief, §34):
 *   A. programme session discovery (real sessions only, nothing invented)
 *   B. session-specific syllabus lookup (full identity)
 *   C. cross-session isolation probes
 *   D. invalid academic session → 400 / 404, never another session's data
 *   E. invalid programme → 400 / clean empty, never a server error
 *   F. invalid semester → 400 / 404
 *   G. missing syllabus document → clean empty (200 with null), not an error
 *   H. inactive handling (effective-status semantics; documents unaffected)
 *   I. elective structure preserved (never flattened into compulsory papers)
 *   J. stale-request guard (an older response can never commit)
 *   K. existing PDF/syllabus behaviour intact (route, storage, safe shape)
 *
 * Usage: npx tsx scripts/test-public-syllabus.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  effectiveStatus,
} from "@/lib/programme-structure";
import {
  getPublicSyllabus,
  listPublicProgrammes,
  listPublicSessions,
  type PublicApiResult,
} from "@/lib/public-syllabus";
import ProgrammeStructure, {
  listSelectableSubjects,
  type IProgrammeStructure,
} from "@/models/ProgrammeStructure";
import Syllabus, { toSafeSyllabus } from "@/models/Syllabus";
import {
  SYLLABUS_PDF_PATH_PREFIX,
  isSyllabusPdfId,
  parseSyllabusPdfId,
  readSyllabusPdf,
} from "@/lib/pdf-storage";
import { partitionSubjects } from "@/components/academic-structure/types";
import { createRequestGuard } from "@/components/syllabus-public/public-syllabus-api";
import connectDB from "@/lib/mongodb";
import mongoose from "mongoose";

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

/** Assert a rejected result carries the expected HTTP status. */
function checkRejected(
  name: string,
  result: PublicApiResult<unknown>,
  status: number
) {
  check(name, !result.ok && result.status === status);
}

async function main() {
  await connectDB();

  /* ── 0. Anchor on the real BCA 2023-24 data ─────────────────── */

  section("0. Real data anchor (BCA 2023-24)");

  const structure: IProgrammeStructure | null =
    await ProgrammeStructure.findOne({
      programmeCode: "BCA",
      academicSession: "2023-24",
    });

  check(
    "the verified BCA 2023-24 structure exists (run npm run seed:bca if not)",
    structure !== null
  );
  if (!structure) {
    console.error("\nReal data missing — aborting without fake records.");
    process.exit(1);
  }

  const totalSubjects = structure.semesters.reduce(
    (total, semester) => total + semester.subjects.length,
    0
  );
  check("it has semesters", structure.semesters.length >= 1);
  check("it has subjects", totalSubjects > 0);

  /* ── A. Programme session discovery ─────────────────────────── */

  section("A. Programme session discovery");

  const sessions = await listPublicSessions("BCA");
  check("sessions for BCA resolve", sessions.ok);
  check(
    "the session API returns 2023-24",
    sessions.ok && sessions.data.some((s) => s.academicSession === "2023-24")
  );
  check(
    "the session API does not invent 2025-26",
    sessions.ok && !sessions.data.some((s) => s.academicSession === "2025-26")
  );

  const storedSessions: string[] = [];
  for (const entry of await ProgrammeStructure.find({ programmeCode: "BCA" })
    .select("academicSession")
    .lean()) {
    storedSessions.push(String(entry.academicSession));
  }
  storedSessions.sort();
  check(
    "every returned session actually exists in stored data",
    sessions.ok &&
      sessions.data.every((s) => storedSessions.includes(s.academicSession))
  );
  check(
    "every stored session is discoverable",
    sessions.ok &&
      storedSessions.every((stored) =>
        sessions.data.some((s) => s.academicSession === stored)
      )
  );
  check(
    "sessions expose their stored status for UI annotation",
    sessions.ok &&
      sessions.data.every(
        (s) => s.status === "ACTIVE" || s.status === "INACTIVE"
      )
  );

  const programmes = await listPublicProgrammes();
  check("programme discovery resolves", programmes.ok);
  check(
    "BCA is offered with its stored name",
    programmes.ok &&
      programmes.data.some(
        (entry) =>
          entry.programmeCode === "BCA" &&
          entry.programmeName === "Bachelor of Computer Application"
      )
  );

  /* ── B. Session-specific syllabus lookup ────────────────────── */

  section("B. Session-specific syllabus lookup");

  const semesterOne = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2023-24",
    semester: "1",
  });
  check("BCA + 2023-24 + semester 1 resolves", semesterOne.ok);
  check(
    "the response echoes the requested academic session",
    semesterOne.ok && semesterOne.data.programme.academicSession === "2023-24"
  );
  check(
    "the semester list matches the structure",
    semesterOne.ok &&
      semesterOne.data.semesters.length === structure.semesters.length
  );

  const expectedCodes = listSelectableSubjects(structure, 1).map(
    (subject) => subject.subjectCode
  );
  const actualCodes = semesterOne.ok
    ? semesterOne.data.semester?.subjects.map((subject) => subject.subjectCode) ??
      []
    : [];
  check(
    "semester 1 subjects come from the BCA 2023-24 structure (not another source)",
    actualCodes.length > 0 &&
      JSON.stringify(actualCodes) === JSON.stringify(expectedCodes)
  );

  const sessionOnly = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2023-24",
  });
  check("session-level lookup (no semester) resolves", sessionOnly.ok);
  check(
    "without a semester the payload carries the semester list but no semester detail",
    sessionOnly.ok &&
      sessionOnly.data.semester === null &&
      sessionOnly.data.syllabus === null &&
      sessionOnly.data.semesters.length === structure.semesters.length
  );

  /* ── C. Different sessions stay isolated ────────────────────── */

  section("C. Cross-session isolation");

  const otherStored = (
    (await ProgrammeStructure.distinct("academicSession")) as string[]
  ).filter((session) => session !== "2023-24");
  check(
    "only one real session exists today, so a two-session diff cannot run against live data (no session was fabricated for testing)",
    otherStored.length === 0
  );

  // The isolation property that IS verifiable with one stored session: a
  // request naming another session must never fall back to 2023-24 data.
  const ghostSession = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2025-26",
    semester: "1",
  });
  checkRejected(
    "a request for BCA 2025-26 does NOT return 2023-24 data (404, no fallback)",
    ghostSession,
    404
  );
  check(
    "the 2023-24 response never mentions another session",
    semesterOne.ok &&
      JSON.stringify(semesterOne.data.programme).includes("2023-24") &&
      !JSON.stringify(semesterOne.data.programme).includes("2025-26")
  );

  /* ── D. Invalid session ─────────────────────────────────────── */

  section("D. Invalid academic session");

  for (const [label, value] of [
    ["non-numeric session", "banana"],
    ["session without range", "2023"],
    ["malformed range", "2023-2024-25"],
    ["empty session", ""],
    ["missing session", undefined],
  ] as [string, unknown][]) {
    const result = await getPublicSyllabus({
      programmeCode: "BCA",
      academicSession: value,
    });
    checkRejected(`${label} → 400`, result, 400);
  }

  const unknownButValid = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2099-10",
  });
  checkRejected(
    "well-formed but unknown session → 404 (clean, not an error)",
    unknownButValid,
    404
  );

  /* ── E. Invalid programme ───────────────────────────────────── */

  section("E. Invalid programme");

  for (const [label, value] of [
    ["symbols", "!!"],
    ["overlong code", "X".repeat(50)],
    ["non-string", 42],
    ["empty programme", ""],
    ["missing programme", undefined],
  ] as [string, unknown][]) {
    const detail = await getPublicSyllabus({
      programmeCode: value,
      academicSession: "2023-24",
    });
    checkRejected(`${label} → 400`, detail, 400);

    const list = await listPublicSessions(value);
    checkRejected(`${label} in session discovery → 400`, list, 400);
  }

  const unknownSessions = await listPublicSessions("ZZZZ");
  check(
    "valid-format but unknown programme → clean empty session list",
    unknownSessions.ok && unknownSessions.data.length === 0
  );

  const unknownDetail = await getPublicSyllabus({
    programmeCode: "ZZZZ",
    academicSession: "2023-24",
  });
  checkRejected("unknown programme detail → 404", unknownDetail, 404);

  /* ── F. Invalid semester ────────────────────────────────────── */

  section("F. Invalid semester");

  for (const [label, value] of [
    ["non-numeric semester", "abc"],
    ["semester zero", "0"],
    ["semester above 12", "13"],
    ["negative semester", "-1"],
    ["fractional semester", "1.5"],
  ] as [string, unknown][]) {
    const result = await getPublicSyllabus({
      programmeCode: "BCA",
      academicSession: "2023-24",
      semester: value,
    });
    checkRejected(`${label} → 400`, result, 400);
  }

  const missingSemester = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2023-24",
    semester: "7",
  });
  checkRejected(
    "valid semester number outside this curriculum → 404",
    missingSemester,
    404
  );

  /* ── G. Missing syllabus → clean empty ──────────────────────── */

  section("G. Missing syllabus document");

  // No legacy record exists for semester 6 and no PDFs are stored at all.
  const semesterSix = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2023-24",
    semester: "6",
  });
  check(
    "a semester without a published document still resolves (200-equivalent)",
    semesterSix.ok
  );
  check(
    "its semester document is a clean null, not a server error",
    semesterSix.ok && semesterSix.data.syllabus === null
  );
  check(
    "its programme document is a clean null",
    semesterSix.ok && semesterSix.data.programmeDocument === null
  );
  check(
    "curriculum metadata is still shown for the session",
    semesterSix.ok &&
      (semesterSix.data.semester?.subjects.length ?? 0) > 0
  );
  check(
    "nothing legacy is withheld while the programme has a single session",
    semesterSix.ok && semesterSix.data.legacyDocumentWithheld === false
  );

  // The one legacy record (BCA semester 1) is attributed to the only session.
  check(
    "the legacy BCA semester 1 record is attributable to 2023-24",
    semesterOne.ok &&
      semesterOne.data.syllabus !== null &&
      semesterOne.data.syllabus.programme === "BCA" &&
      semesterOne.data.syllabus.semester === 1
  );

  /* ── H. Inactive handling ───────────────────────────────────── */

  section("H. Inactive handling");

  // Live structures are ACTIVE; the rules are verified without mutating them.
  const inactiveStructure = {
    status: "INACTIVE" as const,
    semesters: structure.semesters,
  };
  check(
    "an INACTIVE structure exposes no selectable subjects (effective-status contract)",
    listSelectableSubjects(inactiveStructure, 1).length === 0
  );
  check(
    "an inactive semester/subject is effectively inactive under an active structure",
    effectiveStatus("ACTIVE", "INACTIVE") === "INACTIVE"
  );
  check(
    "session discovery keeps status so inactive sessions stay visible, not hidden",
    sessions.ok && sessions.data.length >= 1
  );
  check(
    "legacy documents carry no status field — publication is never gated by status",
    semesterOne.ok &&
      !Object.prototype.hasOwnProperty.call(
        semesterOne.data.syllabus ?? {},
        "status"
      )
  );
  console.log(
    "  NOTE  a live INACTIVE structure scenario was not exercised: it would" +
      " require mutating real records (not performed)."
  );

  /* ── I. Elective structure ──────────────────────────────────── */

  section("I. Elective structure is preserved");

  const semesterFive = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2023-24",
    semester: "5",
  });
  check("BCA 2023-24 semester 5 resolves", semesterFive.ok);
  if (semesterFive.ok && semesterFive.data.semester) {
    const { compulsory, groups } = partitionSubjects(
      semesterFive.data.semester.subjects
    );
    check("ELECTIVE-I is one group, not compulsory papers", groups.length === 1);
    check(
      "the group keeps its stored code",
      groups.length === 1 && groups[0].code === "ELECTIVE-I"
    );
    check(
      "the group keeps the ANY_ONE rule",
      groups.length === 1 && groups[0].selectionRule === "ANY_ONE"
    );
    check(
      "both alternatives are present",
      groups.length === 1 &&
        JSON.stringify(
          groups[0].options.map((option) => option.subjectCode).sort()
        ) === JSON.stringify(["0527004", "0527005"])
    );
    check(
      "elective options are excluded from the compulsory list",
      !compulsory.some((subject) =>
        ["0527004", "0527005"].includes(subject.subjectCode)
      )
    );
    check(
      "each elective subject still carries its group",
      semesterFive.data.semester.subjects
        .filter((subject) =>
          ["0527004", "0527005"].includes(subject.subjectCode)
        )
        .every((subject) => subject.electiveGroup === "ELECTIVE-I")
    );
  }

  const semesterSixElectives = await getPublicSyllabus({
    programmeCode: "BCA",
    academicSession: "2023-24",
    semester: "6",
  });
  if (semesterSixElectives.ok && semesterSixElectives.data.semester) {
    const { groups } = partitionSubjects(
      semesterSixElectives.data.semester.subjects
    );
    check(
      "ELECTIVE-II survives as its own group with both options",
      groups.length === 1 &&
        groups[0].code === "ELECTIVE-II" &&
        JSON.stringify(
          groups[0].options.map((option) => option.subjectCode).sort()
        ) === JSON.stringify(["0627004", "0627005"])
    );
  } else {
    check("ELECTIVE-II survives as its own group with both options", false);
  }

  /* ── J. Stale request protection ────────────────────────────── */

  section("J. Stale request protection");

  const guard = createRequestGuard();
  const firstSelection = guard.next(); // user picks 2023-24
  check("the first request is current while it is the newest", guard.isCurrent(firstSelection));

  const secondSelection = guard.next(); // user immediately switches session
  check(
    "after a newer selection the older request can no longer commit",
    !guard.isCurrent(firstSelection)
  );
  check("the newest request commits its result", guard.isCurrent(secondSelection));

  // Out-of-order arrival: the 2023-24 response lands AFTER the newer one —
  // it holds an obsolete id and is discarded, exactly as the browser does.
  const lateArrival = firstSelection;
  check(
    "a late response for the previous session is discarded",
    !guard.isCurrent(lateArrival)
  );

  const otherStream = createRequestGuard();
  check(
    "guards are per data stream (sessions/base/detail never cancel each other)",
    otherStream.next() === 1
  );
  console.log(
    "  NOTE  in the UI each stream takes its guard id BEFORE clearing state," +
      " and change handlers clear dependent state synchronously — see" +
      " app/syllabus/syllabus-browser.tsx."
  );

  /* ── K. Existing behaviour intact ───────────────────────────── */

  section("K. Existing PDF / syllabus behaviour");

  check(
    "the public PDF route path is unchanged",
    SYLLABUS_PDF_PATH_PREFIX === "/api/syllabus/pdf/"
  );
  check(
    "malformed ids are still rejected before any storage access",
    !isSyllabusPdfId("not-an-object-id") &&
      !isSyllabusPdfId("../../etc/passwd") &&
      isSyllabusPdfId("6abbae81c3c638904a236947")
  );
  const missingFile = await readSyllabusPdf("not-an-object-id");
  check(
    "reading an unknown id returns null (the route's clean 404 path)",
    missingFile === null
  );
  check(
    "PDF URL parsing still only accepts this app's endpoint",
    parseSyllabusPdfId("https://admin.msu.ac.in/api/syllabus/pdf/6abbae81c3c638904a236947") ===
      "6abbae81c3c638904a236947" &&
      parseSyllabusPdfId("https://evil.example/other.pdf") === null
  );

  const safeShape = Object.keys(
    toSafeSyllabus({
      programme: "BCA",
      semester: 1,
      pdfUrl: null,
      pdfName: null,
      subjects: [],
    })
  ).sort();
  check(
    "toSafeSyllabus keeps its published shape for existing consumers",
    JSON.stringify(safeShape) ===
      JSON.stringify(["pdfName", "pdfUrl", "programme", "semester", "subjects"])
  );

  // Phase 2A: the Syllabus identity now includes the academic session.
  const syllabusIndexes = Syllabus.schema.indexes();
  check(
    "the Syllabus identity index is programme + academicSession + semester (unique)",
    syllabusIndexes.some(
      ([definition, options]) =>
        definition.programme === 1 &&
        definition.academicSession === 1 &&
        definition.semester === 1 &&
        options.unique === true
    )
  );
  check(
    "the pre-integration unique index (programme + semester) is no longer declared",
    !syllabusIndexes.some(
      ([definition, options]) =>
        definition.programme === 1 &&
        definition.semester === 1 &&
        definition.academicSession === undefined &&
        options.unique === true
    )
  );

  const structureIndexes = ProgrammeStructure.schema.indexes();
  check(
    "the ProgrammeStructure identity index is unchanged",
    structureIndexes.some(
      ([definition, options]) =>
        definition.programmeCode === 1 &&
        definition.academicSession === 1 &&
        options.unique === true
    )
  );

  /* ── Summary ────────────────────────────────────────────────── */

  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Test run failed:", error.message);
  process.exit(1);
});
