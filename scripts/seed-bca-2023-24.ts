/**
 * Deterministic seed for the VERIFIED BCA (2023-24) academic structure.
 *
 *   University : Maa Shakumbhari University, Saharanpur
 *   Programme  : Bachelor of Computer Application (BCA) — 3 years / 6 semesters
 *   Session    : 2023-24
 *
 * WHY A SCRIPT AND NOT A MANUAL ENTRY:
 * the curriculum below is a transcription of the verified extraction for this
 * programme. Storing it in one reviewable file (instead of typing 38 subjects
 * into the admin UI) means the values can be diffed, and the script re-runs
 * safely: it is IDEMPOTENT, so a second run performs no write at all when the
 * stored curriculum already matches.
 *
 * WHAT IT TOUCHES:
 * exactly ONE document — the ProgrammeStructure identified by
 * programmeCode "BCA" + academicSession "2023-24". Nothing else is read, written
 * or deleted: no other academic structure, no Result, no Syllabus, no Student,
 * and no collection is dropped or reset. The document's identity (its _id,
 * programmeCode and academicSession) and its admin-controlled `status` are never
 * changed by an update — only the curriculum and programme name are synchronised.
 *
 * USAGE
 *   npx tsx scripts/seed-bca-2023-24.ts --dry-run   validate only, NO database access
 *   npm run seed:bca                                validate, then create/update the record
 *
 * VALUES ARE NEVER INVENTED:
 * where the source does not state a value it is left 0 (the schema's documented
 * representation of "this assessment component does not apply"), null (no pass
 * mark stated) or blank, and the subject carries a `note` explaining it. The
 * script asserts every derived total against the total published by the source,
 * so a transcription slip fails the run instead of being stored.
 *
 * No secret value is read, printed or stored here; the database connection comes
 * from the repository's existing helper (@/lib/mongodb), which reads the
 * environment itself.
 */

import dotenv from "dotenv";
import connectDB from "@/lib/mongodb";
import ProgrammeStructure, {
  type IProgrammeSemester,
} from "@/models/ProgrammeStructure";
import {
  parseProgrammeStructureFields,
  parseSemesterList,
  type SemesterInput,
  type SubjectInput,
} from "@/lib/programme-structure";

/* ── Programme identity ────────────────────────────────────────── */

const PROGRAMME = {
  programmeCode: "BCA",
  // The programme code field already carries the "(BCA)" acronym the source
  // prints next to the name, so the name itself is stored without it.
  programmeName: "Bachelor of Computer Application",
  academicSession: "2023-24",
  /** Applied only when the record is CREATED — an existing status is preserved. */
  status: "ACTIVE",
} as const;

/** Elective groups the verified source defines, with their expected size. */
const EXPECTED_ELECTIVE_GROUPS: Record<string, number> = {
  "ELECTIVE-I": 2,
  "ELECTIVE-II": 2,
};

/* ── Verified dataset ──────────────────────────────────────────── */

/**
 * One subject exactly as extracted from the verified source.
 *
 * `internalMax` / `externalMax` / `practicalMax` are the source's assessment
 * components; `sourceTotalMax` is the total the source publishes and is asserted
 * against the derived sum. `note` records anything the source does not specify,
 * so a reader never has to guess why a value is 0 or null.
 */
interface VerifiedSubject {
  subjectCode: string;
  subjectName: string;
  subjectType: "THEORY" | "PRACTICAL";
  credits: number;
  internalMax: number;
  externalMax: number;
  practicalMax: number;
  sourceTotalMax: number;
  /** Pass/qualifying marks, or null when the source states none. */
  minimumMarks: number | null;
  /** "" = compulsory subject; otherwise the elective group it is an option of. */
  electiveGroup: string;
  category?: "CORE" | "VALUE_ADDED";
  /** The internal component is qualifying rather than numerically marked. */
  internalQualifying?: boolean;
  note?: string;
}

interface VerifiedSemester {
  semesterNumber: number;
  subjects: VerifiedSubject[];
}

/** The standard university pattern for a theory paper: 25 internal + 75 external. */
function theory(
  subjectCode: string,
  subjectName: string,
  minimumMarks: number | null
): VerifiedSubject {
  return {
    subjectCode,
    subjectName,
    subjectType: "THEORY",
    credits: 4,
    internalMax: 25,
    externalMax: 75,
    practicalMax: 0,
    sourceTotalMax: 100,
    minimumMarks,
    electiveGroup: "",
  };
}

/**
 * A practical/lab paper whose internal assessment is not published: the source
 * prints a 100-mark external paper only. internalMax stays 0 ("does not apply")
 * instead of being filled with an invented value.
 */
function practicalLab(
  subjectCode: string,
  subjectName: string,
  minimumMarks: number | null
): VerifiedSubject {
  return {
    subjectCode,
    subjectName,
    subjectType: "PRACTICAL",
    credits: 4,
    internalMax: 0,
    externalMax: 100,
    practicalMax: 0,
    sourceTotalMax: 100,
    minimumMarks,
    electiveGroup: "",
    note: "Source does not specify internal marks for this lab; the paper is assessed 100 marks externally.",
  };
}

const SEMESTERS: VerifiedSemester[] = [
  {
    semesterNumber: 1,
    subjects: [
      theory("0127001", "Mathematical Foundation for Computer Science", 40),
      theory("0127002", "Computer Fundamental & Office Automation", 40),
      theory("0127003", "Programming in \u201cC\u201d", 40),
      theory("0127004", "Digital Electronics & Computer Organization", 40),
      theory("0127005", "Business Communication", 40),
      practicalLab("0127080", "C & OFFICE LAB", 40),
      {
        // 2-credit Value Added course whose internal assessment is qualifying.
        // It is NOT converted into a normal 4-credit theory paper.
        subjectCode: "0120008",
        subjectName: "Environmental Studies",
        subjectType: "THEORY",
        credits: 2,
        internalMax: 0,
        externalMax: 100,
        practicalMax: 0,
        sourceTotalMax: 100,
        minimumMarks: 33,
        electiveGroup: "",
        category: "VALUE_ADDED",
        internalQualifying: true,
        note: "Value Added Course (2 credits, qualifying internal, 100-mark external paper).",
      },
    ],
  },
  {
    semesterNumber: 2,
    subjects: [
      theory("0227001", "Mathematics-I", 40),
      theory("0227002", "Advance C-Programming", 40),
      theory("0227003", "Computer Architecture & Assembly language", 40),
      theory("0227004", "Principle of Management", 40),
      theory("0227005", "Financial Accounting with Tally", 40),
      practicalLab("0227080", "C Prog. & Tally LAB", 40),
    ],
  },
  {
    semesterNumber: 3,
    subjects: [
      theory("0327001", "Object Oriented Programming Using C++", 40),
      theory("0327002", "Data Structure Using C & C++", 40),
      theory("0327003", "Operating System concepts", 40),
      theory("0327004", "Web Designing", 40),
      theory("0327005", "Numerical Methods", 40),
      practicalLab("0327080", "Web Designing, C++ & DS LAB", 40),
    ],
  },
  {
    semesterNumber: 4,
    subjects: [
      theory("0427001", "Web Development Using PHP", 40),
      theory("0427002", "Introduction to Python", 40),
      theory("0427003", "Software Engineering", 40),
      theory("0427004", "Introduction to DBMS", 40),
      theory("0427005", "Optimization Techniques", 40),
      practicalLab("0427080", "PHP, Python Prog. & DBMS LAB", 40),
    ],
  },
  {
    semesterNumber: 5,
    subjects: [
      theory("0527001", "Java Programming", 40),
      theory("0527002", "Computer Network", 40),
      theory("0527003", "Computer Graphics & Multimedia Application", 40),
      {
        // ELECTIVE-I — alternative A. Options of one group are alternatives,
        // never simultaneously compulsory subjects.
        ...theory("0527004", "IT Trends & Technologies", 40),
        electiveGroup: "ELECTIVE-I",
      },
      {
        // ELECTIVE-I — alternative B.
        ...theory("0527005", "INTRODUCTION TO STATISTICS", 40),
        electiveGroup: "ELECTIVE-I",
      },
      {
        // 100 marks with no published internal/external split: the whole
        // assessment is recorded as the practical component rather than
        // inventing a 25/75 breakdown.
        subjectCode: "0527065",
        subjectName: "Minor Project",
        subjectType: "PRACTICAL",
        credits: 4,
        internalMax: 0,
        externalMax: 0,
        practicalMax: 100,
        sourceTotalMax: 100,
        minimumMarks: null,
        electiveGroup: "",
        note: "Source shows 100 marks with no internal/external split and no pass mark; no split was invented.",
      },
      practicalLab("0527080", "Java & Computer Graphics LAB", 40),
    ],
  },
  {
    semesterNumber: 6,
    subjects: [
      theory("0627001", "Computer Network Security", 40),
      {
        // The extraction flags this row for verification and prints a pass mark
        // equal to the paper total, which contradicts every other row (40 = 40%
        // of 100). It is therefore left as "not stated" (null) rather than
        // storing an unverified value; the 25 + 75 structure itself is kept.
        ...theory("0627002", "Information System Analysis Design & Implementation", null),
        note: "Extraction flagged as unverified and its pass mark (100) equals the paper total; no pass mark was stored. Assessment structure 25 + 75 is confirmed.",
      },
      theory("0627003", "E-Commerce", 40),
      {
        // ELECTIVE-II — alternative A.
        ...theory("0627004", "Cloud Computing", 40),
        electiveGroup: "ELECTIVE-II",
      },
      {
        // ELECTIVE-II — alternative B.
        ...theory("0627005", "DATA WAREHOUSING & DATA MINING", 40),
        electiveGroup: "ELECTIVE-II",
      },
      {
        // 8 credits. The source quantifies the external evaluation (100 marks)
        // and describes internal/viva components in the project guidelines
        // without numbers, so only the published figure is stored.
        subjectCode: "0627065",
        subjectName: "Major Project",
        subjectType: "PRACTICAL",
        credits: 8,
        internalMax: 0,
        externalMax: 100,
        practicalMax: 0,
        sourceTotalMax: 100,
        minimumMarks: null,
        electiveGroup: "",
        note: "8-credit project; source states external evaluation of 100 marks and mentions internal assessment/viva components without marks. No split or component total was invented.",
      },
    ],
  },
];

/* ── Dataset → model input ─────────────────────────────────────── */

function toSubjectInput(subject: VerifiedSubject): SubjectInput {
  return {
    subjectCode: subject.subjectCode,
    subjectName: subject.subjectName,
    credits: subject.credits,
    subjectType: subject.subjectType,
    category: subject.category ?? "CORE",
    status: "ACTIVE",
    electiveGroup: subject.electiveGroup,
    // The rule lives on the group's members; ANY_ONE is the only rule the source
    // states ("any one of the following").
    selectionRule: subject.electiveGroup ? "ANY_ONE" : null,
    assessment: {
      internalMax: subject.internalMax,
      externalMax: subject.externalMax,
      practicalMax: subject.practicalMax,
      // Derived by parseSemesterList; the source's own total is asserted against it.
      totalMax: subject.sourceTotalMax,
      minimumMarks: subject.minimumMarks,
      internalQualifying: subject.internalQualifying ?? false,
    },
  };
}

/**
 * Validate the verified dataset with the SAME rules the admin API uses and
 * assert every derived total against the total the source published.
 * Throws with a precise message on any mismatch — a transcription slip must
 * never reach the database.
 */
function buildCurriculum(): SemesterInput[] {
  const fields = parseProgrammeStructureFields(PROGRAMME);
  if (!fields.ok) throw new Error(`Programme details are invalid: ${fields.message}`);

  const parsed = parseSemesterList(
    SEMESTERS.map((semester) => ({
      semesterNumber: semester.semesterNumber,
      // The source states no semester label; the UI falls back to "Semester N".
      semesterName: "",
      status: "ACTIVE",
      subjects: semester.subjects.map(toSubjectInput),
    }))
  );

  if (!parsed.ok) throw new Error(`Verified dataset is invalid: ${parsed.message}`);

  for (let i = 0; i < parsed.data.length; i++) {
    const semester = parsed.data[i];
    const verified = SEMESTERS[i];

    for (let j = 0; j < semester.subjects.length; j++) {
      const subject = semester.subjects[j];
      const source = verified.subjects[j];

      if (subject.assessment.totalMax !== source.sourceTotalMax) {
        throw new Error(
          `${subject.subjectCode}: derived total ${subject.assessment.totalMax} does not match the source total ${source.sourceTotalMax}.`
        );
      }
    }
  }

  const numbers = parsed.data.map((semester) => semester.semesterNumber);
  if (numbers.join(",") !== "1,2,3,4,5,6") {
    throw new Error(`Expected semesters 1-6, received: ${numbers.join(", ")}`);
  }

  // Every elective group must still hold its verified options and agree on one
  // selection rule (parseSemesterList already rejects mixed rules).
  const groupSizes = new Map<string, number>();
  for (const semester of parsed.data) {
    for (const subject of semester.subjects) {
      if (!subject.electiveGroup) continue;
      groupSizes.set(
        subject.electiveGroup,
        (groupSizes.get(subject.electiveGroup) ?? 0) + 1
      );

      if (subject.selectionRule !== "ANY_ONE") {
        throw new Error(
          `${subject.subjectCode}: expected the ANY_ONE selection rule in group ${subject.electiveGroup}.`
        );
      }
    }
  }

  for (const [group, expected] of Object.entries(EXPECTED_ELECTIVE_GROUPS)) {
    const actual = groupSizes.get(group) ?? 0;
    if (actual !== expected) {
      throw new Error(`Elective group ${group} has ${actual} options, expected ${expected}.`);
    }
  }

  return parsed.data;
}

/* ── Reporting helpers ─────────────────────────────────────────── */

function countSubjects(semesters: SemesterInput[]): number {
  return semesters.reduce((total, semester) => total + semester.subjects.length, 0);
}

/** Stable key for one subject, so two curricula can be compared field by field. */
function subjectKey(subject: {
  subjectCode: string;
  subjectName: string;
  credits: number;
  subjectType: string;
  category?: string;
  status: string;
  electiveGroup?: string;
  selectionRule?: string | null;
  assessment: {
    internalMax: number;
    externalMax: number;
    practicalMax: number;
    totalMax: number;
    minimumMarks?: number | null;
    internalQualifying?: boolean;
  };
}): string {
  return [
    subject.subjectCode,
    subject.subjectName,
    subject.credits,
    subject.subjectType,
    subject.category ?? "CORE",
    subject.status,
    subject.electiveGroup ?? "",
    subject.selectionRule ?? "",
    subject.assessment.internalMax,
    subject.assessment.externalMax,
    subject.assessment.practicalMax,
    subject.assessment.totalMax,
    subject.assessment.minimumMarks ?? "none",
    subject.assessment.internalQualifying ? "qualifying" : "marked",
  ].join("|");
}

function curriculumKey(
  semesters: {
    semesterNumber: number;
    semesterName?: string;
    status: string;
    subjects: Parameters<typeof subjectKey>[0][];
  }[]
): string {
  return [...semesters]
    .sort((a, b) => a.semesterNumber - b.semesterNumber)
    .map(
      (semester) =>
        `${semester.semesterNumber}#${semester.status}#${semester.semesterName ?? ""}#` +
        // Subject order inside a semester is not meaningful, so the keys are
        // sorted — reordering subjects by hand must not trigger a rewrite.
        semester.subjects.map(subjectKey).sort().join(",")
    )
    .join(";");
}

function printSummary(semesters: SemesterInput[]): void {
  console.log(
    `\n${PROGRAMME.programmeName} (${PROGRAMME.programmeCode}) — ${PROGRAMME.academicSession}`
  );
  console.log(
    `${semesters.length} semesters, ${countSubjects(semesters)} subject entries\n`
  );

  for (const semester of semesters) {
    const electives = semester.subjects.filter((subject) => subject.electiveGroup);
    const compulsory = semester.subjects.length - electives.length;

    console.log(
      `  Semester ${semester.semesterNumber}: ${compulsory} compulsory` +
        (electives.length
          ? ` + ${electives.length} elective option(s) in ${new Set(
              electives.map((subject) => subject.electiveGroup)
            ).size} group(s)`
          : "")
    );

    for (const subject of semester.subjects) {
      const group = subject.electiveGroup ? ` [${subject.electiveGroup}]` : "";
      const minimum =
        subject.assessment.minimumMarks === null
          ? "min not stated"
          : `min ${subject.assessment.minimumMarks}`;
      const internal = subject.assessment.internalQualifying
        ? "internal qualifying"
        : `internal ${subject.assessment.internalMax}`;

      console.log(
        `    ${subject.subjectCode}  ${subject.subjectName}${group} — ${subject.credits} cr, ` +
          `${internal} + external ${subject.assessment.externalMax}` +
          (subject.assessment.practicalMax
            ? ` + practical ${subject.assessment.practicalMax}`
            : "") +
          ` = ${subject.assessment.totalMax} (${minimum})`
      );
    }
    console.log("");
  }

  const special = SEMESTERS.flatMap((semester) =>
    semester.subjects
      .filter((subject) => subject.note)
      .map((subject) => `${subject.subjectCode} ${subject.subjectName}: ${subject.note}`)
  );

  if (special.length > 0) {
    console.log("Source notes / unverified values (nothing was invented):");
    for (const line of special) console.log(`  - ${line}`);
    console.log("");
  }
}

/* ── Main ──────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  console.log("Verifying the BCA 2023-24 dataset against the admin validation rules...");
  const semesters = buildCurriculum();
  printSummary(semesters);

  if (dryRun) {
    console.log(
      "Dry run complete: the dataset is valid. No database connection was opened and nothing was written.\n"
    );
    return;
  }

  // The repository's existing convention for scripts that need the database:
  // load the project's env file, then connect with the shared helper. Values are
  // never printed.
  dotenv.config({ path: ".env.local" });

  await connectDB();

  const existing = await ProgrammeStructure.findOne({
    programmeCode: PROGRAMME.programmeCode,
    academicSession: PROGRAMME.academicSession,
  });

  /* ── Create ──────────────────────────────────────────────────── */
  if (!existing) {
    const created = await ProgrammeStructure.create({
      programmeCode: PROGRAMME.programmeCode,
      programmeName: PROGRAMME.programmeName,
      academicSession: PROGRAMME.academicSession,
      status: PROGRAMME.status,
      semesters,
    });

    console.log(
      `Created: ${created.programmeCode} ${created.academicSession} — ${created.semesters.length} semesters, ` +
        `${countSubjects(semesters)} subject entries (id ${created._id}).`
    );
    return;
  }

  /* ── Compare, then update only when something actually differs ─ */
  const storedSemesters: IProgrammeSemester[] = ((existing.semesters ?? []) as IProgrammeSemester[]).map((semester) => ({
    semesterNumber: semester.semesterNumber,
    semesterName: semester.semesterName || "",
    status: semester.status,
    subjects: semester.subjects.map((subject) => ({
      subjectCode: subject.subjectCode,
      subjectName: subject.subjectName,
      credits: subject.credits,
      subjectType: subject.subjectType,
      category: subject.category ?? "CORE",
      status: subject.status,
      electiveGroup: subject.electiveGroup || "",
      selectionRule: subject.selectionRule ?? null,
      assessment: {
        internalMax: subject.assessment.internalMax,
        externalMax: subject.assessment.externalMax,
        practicalMax: subject.assessment.practicalMax,
        totalMax: subject.assessment.totalMax,
        minimumMarks: subject.assessment.minimumMarks ?? null,
        internalQualifying: subject.assessment.internalQualifying ?? false,
      },
    })),
  }));

  const unchanged =
    existing.programmeName === PROGRAMME.programmeName &&
    curriculumKey(storedSemesters) === curriculumKey(semesters);

  if (unchanged) {
    console.log(
      `Already up to date: ${existing.programmeCode} ${existing.academicSession} matches the verified dataset ` +
        `(${storedSemesters.length} semesters, ${countSubjects(semesters)} subject entries). No write was performed.`
    );
    return;
  }

  const before = `${storedSemesters.length} semesters / ${storedSemesters.reduce(
    (total, semester) => total + semester.subjects.length,
    0
  )} subject entries`;

  // Only the curriculum and the programme name are synchronised. The document's
  // identity and its admin-controlled status are deliberately left alone, and the
  // existing _id is reused — no second BCA 2023-24 record is ever inserted.
  existing.programmeName = PROGRAMME.programmeName;
  existing.semesters.splice(0, existing.semesters.length);
  for (const semester of semesters) {
    existing.semesters.push(semester);
  }
  await existing.save();

  console.log(
    `Updated: ${existing.programmeCode} ${existing.academicSession} — was ${before}, now ` +
      `${semesters.length} semesters / ${countSubjects(semesters)} subject entries. ` +
      `(status left as "${existing.status}")`
  );
}

main()
  .then(async () => {
    // Close the connection explicitly so the script always exits promptly.
    const mongoose = await import("mongoose");
    await mongoose.default.disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nSeeding failed: ${message}`);
    try {
      const mongoose = await import("mongoose");
      await mongoose.default.disconnect();
    } catch {
      // The connection may never have been opened (e.g. a validation failure).
    }
    process.exit(1);
  });
