/**
 * Offline verification of the Academic Structure (programme curriculum) rules.
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. Because the rules live in
 * lib/programme-structure.ts (pure) and the model exposes its mappers and the
 * future integration contract as plain functions, the business rules can be
 * exercised without a database.
 *
 * Coverage:
 *   1. a valid programme structure
 *   2. duplicate programme + academic session (the unique index that prevents it)
 *   3. invalid subjects
 *   4. inactive subjects
 *   5. inactive semesters (effective availability)
 *   6. inactive programme structures (effective availability)
 *   7. totalMax is always derived from its components
 *   8. subject-code uniqueness inside one semester
 *   9. safe deletion behaviour
 *
 * Usage: npx tsx scripts/test-programme-structure-validation.ts
 */
import {
  MAX_SEMESTERS_PER_STRUCTURE,
  MAX_SUBJECTS_PER_SEMESTER,
  STRUCTURE_STATUSES,
  SUBJECT_TYPES,
  computeTotalMax,
  effectiveStatus,
  findDuplicateSubjectCode,
  isEffectivelyActive,
  parseAssessment,
  parseProgrammeStructureFields,
  parseSemesterInput,
  parseSemesterList,
  parseSubjectInput,
  resolveStructureDeleteDecision,
} from "@/lib/programme-structure";
import ProgrammeStructure, {
  listSelectableSubjects,
  toSafeProgrammeStructure,
} from "@/models/ProgrammeStructure";

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

/** A minimal subject input, overridable per case. */
function subject(overrides: Record<string, unknown> = {}) {
  return {
    subjectCode: "CS401",
    subjectName: "Data Structures",
    credits: 4,
    subjectType: "THEORY",
    assessment: { internalMax: 30, externalMax: 70, practicalMax: 0 },
    ...overrides,
  };
}

/** A minimal semester input, overridable per case. */
function semester(overrides: Record<string, unknown> = {}) {
  return {
    semesterNumber: 4,
    semesterName: "Semester IV",
    status: "ACTIVE",
    subjects: [subject()],
    ...overrides,
  };
}

/** A minimal programme structure input, overridable per case. */
function structure(overrides: Record<string, unknown> = {}) {
  return {
    programmeCode: "BCA",
    programmeName: "Bachelor of Computer Applications",
    academicSession: "2025-26",
    status: "ACTIVE",
    ...overrides,
  };
}

/* ── 1. Valid programme structure ──────────────────────────── */

section("1. A valid programme structure");

const validFields = parseProgrammeStructureFields(structure());
check("programme fields validate", validFields.ok);
check(
  "the programme code is normalised to uppercase",
  validFields.ok && validFields.data.programmeCode === "BCA"
);

const validSemesters = parseSemesterList([
  semester({ semesterNumber: 1, subjects: [] }),
  semester({
    semesterNumber: 4,
    subjects: [
      subject(),
      subject({
        subjectCode: "CS402",
        subjectName: "DBMS",
        assessment: { internalMax: 30, externalMax: 70 },
      }),
    ],
  }),
]);
check("a semester list validates", validSemesters.ok);
check(
  "an empty semester is allowed while a curriculum is being built",
  validSemesters.ok && validSemesters.data[0].subjects.length === 0
);
check(
  "the assessment total is derived per subject",
  validSemesters.ok &&
    validSemesters.data[1].subjects[0].assessment.totalMax === 100
);

const statuses = parseProgrammeStructureFields(structure({ status: "INACTIVE" }));
check("status defaults to / accepts the controlled set", statuses.ok);
check(
  "an unknown status is rejected",
  !parseProgrammeStructureFields(structure({ status: "ARCHIVED" })).ok
);
check("the controlled status set is ACTIVE/INACTIVE", STRUCTURE_STATUSES.length === 2);

const missingName = parseProgrammeStructureFields(structure({ programmeName: "  " }));
check("a blank programme name is rejected", !missingName.ok);
check(
  "a malformed academic session is rejected",
  !parseProgrammeStructureFields(structure({ academicSession: "2025" })).ok
);
check(
  "a valid academic session is accepted",
  parseProgrammeStructureFields(structure({ academicSession: "2025-2026" })).ok
);

/* ── 2. Duplicate programme + academic session ─────────────── */

section("2. Duplicate programme + academic session");

const identityIndex = ProgrammeStructure.schema
  .indexes()
  .find(
    (index) =>
      index[0].programmeCode === 1 &&
      index[0].academicSession === 1 &&
      index[1]?.unique === true
  );
check(
  "the model defines a unique index on programmeCode + academicSession",
  !!identityIndex
);

const toSafe = toSafeProgrammeStructure({
  _id: "abc",
  programmeCode: validFields.ok ? validFields.data.programmeCode : "BCA",
  programmeName: validFields.ok ? validFields.data.programmeName : "",
  academicSession: validFields.ok ? validFields.data.academicSession : "",
  status: "ACTIVE",
  semesters: validSemesters.ok ? validSemesters.data : [],
  createdAt: new Date(),
  updatedAt: new Date(),
});
check("the safe mapper drops _id/__v and exposes `id`", toSafe.id === "abc");
check(
  "the safe mapper sorts semesters by number and counts them",
  toSafe.semesters[0].semesterNumber === 1 && toSafe.semesterCount === 2
);
check(
  "the safe mapper counts subjects across semesters",
  toSafe.subjectCount === 2
);

/* ── 3. Invalid subjects ──────────────────────────────────── */

section("3. Invalid subjects");

check("a valid subject validates", parseSubjectInput(subject()).ok);
check(
  "a missing subject code is rejected",
  !parseSubjectInput(subject({ subjectCode: "   " })).ok
);
check(
  "a missing subject name is rejected",
  !parseSubjectInput(subject({ subjectName: "" })).ok
);
check(
  "negative credits are rejected",
  !parseSubjectInput(subject({ credits: -1 })).ok
);
check(
  "non-numeric credits are rejected",
  !parseSubjectInput(subject({ credits: "four" })).ok
);
check(
  "zero credits are allowed (non-negative)",
  parseSubjectInput(subject({ credits: 0 })).ok
);
check(
  "an unknown subject type is rejected",
  !parseSubjectInput(subject({ subjectType: "SEMINAR" })).ok
);
check(
  "every controlled subject type is accepted",
  SUBJECT_TYPES.every((type) => parseSubjectInput(subject({ subjectType: type })).ok)
);
check(
  "an unknown status is rejected",
  !parseSubjectInput(subject({ status: "RETIRED" })).ok
);
check(
  "a subject code with unsafe characters is rejected",
  !parseSubjectInput(subject({ subjectCode: "CS 401 <script>" })).ok
);
check(
  "a valid code with a hyphen is accepted",
  parseSubjectInput(subject({ subjectCode: "bca-101" })).ok
);
check(
  "the subject code is normalised to uppercase",
  (() => {
    const result = parseSubjectInput(subject({ subjectCode: "bca-101" }));
    return result.ok && result.data.subjectCode === "BCA-101";
  })()
);

/* ── 7. totalMax is derived ───────────────────────────────── */

section("7. totalMax is always the sum of its components");

check(
  "computeTotalMax adds internal + external + practical",
  computeTotalMax({ internalMax: 30, externalMax: 70, practicalMax: 0 }) === 100
);
check(
  "a theory + practical subject adds all three",
  computeTotalMax({ internalMax: 30, externalMax: 50, practicalMax: 20 }) === 100
);
check(
  "a client-sent totalMax is ignored (recomputed)",
  (() => {
    const result = parseAssessment({
      internalMax: 30,
      externalMax: 70,
      practicalMax: 0,
      totalMax: 999,
    });
    return result.ok && result.data.totalMax === 100;
  })()
);
check(
  "omitted components default to 0",
  (() => {
    const result = parseAssessment({ externalMax: 100 });
    return result.ok && result.data.totalMax === 100 && result.data.internalMax === 0;
  })()
);
check(
  "negative marks are rejected",
  !parseAssessment({ internalMax: -5, externalMax: 70 }).ok
);
check(
  "a fractional maximum is rejected",
  !parseAssessment({ internalMax: 29.5, externalMax: 70 }).ok
);
check(
  "an all-zero assessment structure is rejected",
  !parseAssessment({ internalMax: 0, externalMax: 0, practicalMax: 0 }).ok
);

/* ── 8. Subject-code uniqueness inside one semester ───────── */

section("8. Subject-code uniqueness inside a semester");

const duplicateSubjectCodes = [
  { subjectCode: "CS401" },
  { subjectCode: "CS402" },
  { subjectCode: "cs401" },
];
check(
  "a duplicate subject code is detected case-insensitively",
  findDuplicateSubjectCode(duplicateSubjectCodes) === "cs401"
);
check(
  "unique codes return null",
  findDuplicateSubjectCode([{ subjectCode: "CS401" }, { subjectCode: "CS402" }]) ===
    null
);
check(
  "a semester with a duplicate subject code is rejected",
  !parseSemesterInput(semester({ subjects: duplicateSubjectCodes })).ok
);
check(
  "the same code in a DIFFERENT semester is fine (not globally unique)",
  parseSemesterList([
    semester({ semesterNumber: 1, subjects: [subject({ subjectCode: "CS401" })] }),
    semester({
      semesterNumber: 2,
      subjects: [subject({ subjectCode: "CS401", subjectName: "Data Structures II" })],
    }),
  ]).ok
);
check(
  "duplicate semester numbers are rejected",
  !parseSemesterList([semester({ semesterNumber: 1 }), semester({ semesterNumber: 1 })]).ok
);
check(
  "an out-of-range semester number is rejected",
  !parseSemesterInput(semester({ semesterNumber: 13 })).ok
);
check(
  "more than the allowed number of semesters is rejected",
  !parseSemesterList(
    Array.from({ length: MAX_SEMESTERS_PER_STRUCTURE + 1 }, (_, i) =>
      semester({ semesterNumber: i + 1, subjects: [] })
    )
  ).ok
);
check(
  "more than the allowed number of subjects is rejected",
  !parseSemesterInput(
    semester({
      subjects: Array.from({ length: MAX_SUBJECTS_PER_SEMESTER + 1 }, (_, i) =>
        subject({ subjectCode: `CS${400 + i}` })
      ),
    })
  ).ok
);

/* ── 4–6. Effective status (inactive subject / semester / structure) ── */

section("4–6. Effective availability (parent status gates children)");

check(
  "an active subject stays active",
  isEffectivelyActive("ACTIVE", "ACTIVE")
);
check("an inactive subject is unavailable", !isEffectivelyActive("ACTIVE", "INACTIVE"));
check(
  "a parent INACTIVE makes an active child effectively INACTIVE",
  effectiveStatus("INACTIVE", "ACTIVE") === "INACTIVE"
);
check(
  "effective status is the only place the cascade happens (no writes)",
  effectiveStatus("INACTIVE", "INACTIVE") === "INACTIVE"
);

/** A stored structure (plain object) with the given statuses. */
function stored(overrides: {
  status?: "ACTIVE" | "INACTIVE";
  semesterStatus?: "ACTIVE" | "INACTIVE";
  subjectStatus?: "ACTIVE" | "INACTIVE";
  subjectStatuses?: ("ACTIVE" | "INACTIVE")[];
}) {
  const subjectStatuses =
    overrides.subjectStatuses ?? [overrides.subjectStatus ?? "ACTIVE"];
  return {
    programmeCode: "BCA",
    programmeName: "Bachelor of Computer Applications",
    academicSession: "2025-26",
    status: overrides.status ?? "ACTIVE",
    semesters: [
      {
        semesterNumber: 4,
        semesterName: "Semester IV",
        status: overrides.semesterStatus ?? "ACTIVE",
        subjects: subjectStatuses.map((status, index) => ({
          subjectCode: `CS40${index + 1}`,
          subjectName: `Subject ${index + 1}`,
          credits: 4,
          subjectType: "THEORY" as const,
          category: "CORE" as const,
          status,
          electiveGroup: "",
          selectionRule: null,
          assessment: {
            internalMax: 30,
            externalMax: 70,
            practicalMax: 0,
            totalMax: 100,
            minimumMarks: 40,
            internalQualifying: false,
          },
        })),
      },
    ],
  };
}

check(
  "an active subject is selectable",
  listSelectableSubjects(stored({}), 4).length === 1
);
check(
  "an INACTIVE subject is not selectable (4)",
  listSelectableSubjects(stored({ subjectStatus: "INACTIVE" }), 4).length === 0
);
check(
  "an INACTIVE semester makes its active subjects unavailable (5)",
  listSelectableSubjects(stored({ semesterStatus: "INACTIVE" }), 4).length === 0
);
check(
  "an INACTIVE structure makes everything unavailable (6)",
  listSelectableSubjects(stored({ status: "INACTIVE" }), 4).length === 0
);
check(
  "reactivating the parent restores only the children that were active",
  listSelectableSubjects(
    stored({ subjectStatuses: ["ACTIVE", "INACTIVE"] }),
    4
  ).length === 1 &&
    listSelectableSubjects(
      stored({ status: "INACTIVE", subjectStatuses: ["ACTIVE", "INACTIVE"] }),
      4
    ).length === 0
);
check(
  "an unknown semester yields no subjects",
  listSelectableSubjects(stored({}), 9).length === 0
);
check(
  "selectable subjects carry the academic metadata (credits + assessment)",
  (() => {
    const selectable = listSelectableSubjects(stored({}), 4);
    return (
      selectable[0].credits === 4 &&
      selectable[0].assessment.totalMax === 100 &&
      selectable[0].subjectType === "THEORY"
    );
  })()
);

/* ── 9. Safe deletion ──────────────────────────────────────── */

section("9. Safe deletion behaviour");

const activeDecision = resolveStructureDeleteDecision("ACTIVE");
check("an ACTIVE structure cannot be permanently deleted", !activeDecision.allowed);
check(
  "the refusal explains that deactivation comes first",
  /Deactivate it first/i.test(activeDecision.message)
);

const inactiveDecision = resolveStructureDeleteDecision("INACTIVE");
check("an INACTIVE structure may be permanently deleted", inactiveDecision.allowed);
check(
  "the confirmation states that deletion is destructive and non-cascading",
  /destructive/i.test(inactiveDecision.message) &&
    /NOT deleted/i.test(inactiveDecision.message)
);

/* ── 11. Elective groups, value-added courses, minimum marks ── */

section("11. Elective groups, Value Added courses and minimum marks");

check(
  "an elective option keeps its group and rule",
  (() => {
    const result = parseSubjectInput(
      subject({ electiveGroup: "ELECTIVE-I", selectionRule: "ANY_ONE" })
    );
    return (
      result.ok &&
      result.data.electiveGroup === "ELECTIVE-I" &&
      result.data.selectionRule === "ANY_ONE"
    );
  })()
);
check(
  "a group member without a rule defaults to ANY_ONE",
  (() => {
    const result = parseSubjectInput(subject({ electiveGroup: "ELECTIVE-I" }));
    return result.ok && result.data.selectionRule === "ANY_ONE";
  })()
);
check(
  "a compulsory subject has no group and no rule",
  (() => {
    const result = parseSubjectInput(subject());
    return result.ok && result.data.electiveGroup === "" && result.data.selectionRule === null;
  })()
);
check(
  "a selection rule without a group is rejected",
  !parseSubjectInput(subject({ selectionRule: "ANY_ONE" })).ok
);
check(
  "an unknown selection rule is rejected",
  !parseSubjectInput(subject({ electiveGroup: "ELECTIVE-I", selectionRule: "ANY_TWO" })).ok
);
check(
  "an elective group name longer than 40 characters is rejected",
  !parseSubjectInput(subject({ electiveGroup: "E".repeat(41) })).ok
);
check(
  "elective options may sit in one semester beside compulsory subjects",
  parseSemesterInput(
    semester({
      subjects: [
        subject({ subjectCode: "CS401" }),
        subject({ subjectCode: "CS402", electiveGroup: "ELECTIVE-I" }),
        subject({ subjectCode: "CS403", electiveGroup: "ELECTIVE-I" }),
      ],
    })
  ).ok
);
check(
  "a group that mixes selection rules is rejected",
  !parseSemesterInput(
    semester({
      subjects: [
        subject({ subjectCode: "CS402", electiveGroup: "ELECTIVE-I", selectionRule: "ANY_ONE" }),
        subject({ subjectCode: "CS403", electiveGroup: "ELECTIVE-I", selectionRule: "ANY_TWO" }),
      ],
    })
  ).ok
);

check(
  "a catalogue subject defaults to CORE",
  (() => {
    const result = parseSubjectInput(subject());
    return result.ok && result.data.category === "CORE";
  })()
);
check(
  "VALUE_ADDED is an accepted category",
  (() => {
    const result = parseSubjectInput(subject({ category: "VALUE_ADDED" }));
    return result.ok && result.data.category === "VALUE_ADDED";
  })()
);
check(
  "an unknown category is rejected",
  !parseSubjectInput(subject({ category: "OPTIONAL" })).ok
);

check(
  "a stated pass mark is stored",
  (() => {
    const result = parseAssessment({ internalMax: 25, externalMax: 75, minimumMarks: 40 });
    return result.ok && result.data.minimumMarks === 40;
  })()
);
check(
  "an absent pass mark stays null (never 0)",
  (() => {
    const result = parseAssessment({ internalMax: 25, externalMax: 75 });
    return result.ok && result.data.minimumMarks === null;
  })()
);
check(
  "a negative pass mark is rejected",
  !parseAssessment({ internalMax: 25, externalMax: 75, minimumMarks: -1 }).ok
);
check(
  "an internal can be marked qualifying with no internal maximum",
  (() => {
    const result = parseAssessment({
      externalMax: 100,
      minimumMarks: 33,
      internalQualifying: true,
    });
    return (
      result.ok &&
      result.data.internalQualifying === true &&
      result.data.internalMax === 0 &&
      result.data.totalMax === 100
    );
  })()
);
check(
  "a qualifying internal cannot also carry a numeric maximum",
  !parseAssessment({ internalMax: 25, externalMax: 75, internalQualifying: true }).ok
);
check(
  "a project with no published split is recorded in one component",
  (() => {
    const result = parseAssessment({ practicalMax: 100 });
    return result.ok && result.data.totalMax === 100 && result.data.minimumMarks === null;
  })()
);
check(
  "the value-added pattern (2 credits, qualifying internal, 100 external) parses",
  (() => {
    const result = parseSubjectInput(
      subject({
        subjectCode: "0120008",
        subjectName: "Environmental Studies",
        credits: 2,
        category: "VALUE_ADDED",
        assessment: { externalMax: 100, minimumMarks: 33, internalQualifying: true },
      })
    );
    return (
      result.ok &&
      result.data.credits === 2 &&
      result.data.category === "VALUE_ADDED" &&
      result.data.assessment.totalMax === 100
    );
  })()
);

check(
  "selectable subjects carry their elective metadata for later Result use",
  (() => {
    const selectable = listSelectableSubjects(stored({}), 4);
    return "electiveGroup" in selectable[0] && "category" in selectable[0];
  })()
);

/* ── 10. Model-level validation (still no database) ────────── */

section("10. Model validation (offline — documents are validated in memory)");

/** Build an unsaved document; validateSync() runs every schema validator. */
function document(
  assessment: Record<string, number | boolean | null>,
  overrides: Record<string, unknown> = {}
) {
  return new ProgrammeStructure({
    programmeCode: "BCA",
    programmeName: "Bachelor of Computer Applications",
    academicSession: "2025-26",
    status: "ACTIVE",
    semesters: [
      {
        semesterNumber: 1,
        semesterName: "Semester I",
        status: "ACTIVE",
        subjects: [
          {
            subjectCode: "cs101",
            subjectName: "Mathematics",
            credits: 4,
            subjectType: "THEORY",
            status: "ACTIVE",
            assessment,
          },
        ],
        // Applied last so a case can replace whole fields (e.g. subjects).
        ...overrides,
      },
    ],
  });
}

check(
  "a matching totalMax passes model validation",
  !document({ internalMax: 30, externalMax: 70, practicalMax: 0, totalMax: 100 }).validateSync()
);
check(
  "a mismatched totalMax is rejected by the model",
  !!document({ internalMax: 30, externalMax: 70, practicalMax: 0, totalMax: 999 }).validateSync()
);
check(
  "an all-zero assessment structure is rejected by the model",
  !!document({ internalMax: 0, externalMax: 0, practicalMax: 0, totalMax: 0 }).validateSync()
);
check(
  "an out-of-range semester number is rejected by the model",
  !!document(
    { internalMax: 30, externalMax: 70, practicalMax: 0, totalMax: 100 },
    { semesterNumber: 13 }
  ).validateSync()
);
check(
  "an unknown subject type is rejected by the model",
  !!document(
    { internalMax: 30, externalMax: 70, practicalMax: 0, totalMax: 100 },
    {
      subjects: [
        {
          subjectCode: "CS101",
          subjectName: "Mathematics",
          credits: 4,
          subjectType: "SEMINAR",
          assessment: { internalMax: 30, externalMax: 70, practicalMax: 0, totalMax: 100 },
        },
      ],
    }
  ).validateSync()
);
check(
  "the model defaults a subject to CORE, no elective group, no rule, no pass mark",
  (() => {
    const subject = document({
      internalMax: 30,
      externalMax: 70,
      practicalMax: 0,
      totalMax: 100,
    }).semesters[0].subjects[0];
    return (
      subject.category === "CORE" &&
      subject.electiveGroup === "" &&
      subject.selectionRule === null &&
      subject.assessment.minimumMarks === null &&
      subject.assessment.internalQualifying === false
    );
  })()
);
check(
  "the model accepts an elective option with its group and rule",
  !document(
    { internalMax: 25, externalMax: 75, practicalMax: 0, totalMax: 100 },
    {
      subjects: [
        {
          subjectCode: "0527004",
          subjectName: "IT Trends & Technologies",
          credits: 4,
          subjectType: "THEORY",
          category: "CORE",
          electiveGroup: "ELECTIVE-I",
          selectionRule: "ANY_ONE",
          assessment: { internalMax: 25, externalMax: 75, practicalMax: 0, totalMax: 100 },
        },
      ],
    }
  ).validateSync()
);
check(
  "the model rejects a qualifying internal that also carries a numeric maximum",
  !!document({
    internalMax: 25,
    externalMax: 75,
    practicalMax: 0,
    totalMax: 100,
    internalQualifying: true,
  }).validateSync()
);
check(
  "the model rejects an unknown selection rule",
  !!document(
    { internalMax: 25, externalMax: 75, practicalMax: 0, totalMax: 100 },
    {
      subjects: [
        {
          subjectCode: "0527004",
          subjectName: "IT Trends & Technologies",
          credits: 4,
          subjectType: "THEORY",
          electiveGroup: "ELECTIVE-I",
          selectionRule: "ANY_TWO",
          assessment: { internalMax: 25, externalMax: 75, practicalMax: 0, totalMax: 100 },
        },
      ],
    }
  ).validateSync()
);

check(
  "the stored subject code is normalised to uppercase",
  document({ internalMax: 30, externalMax: 70, practicalMax: 0, totalMax: 100 }).semesters[0]
    .subjects[0].subjectCode === "CS101"
);
check(
  "the model reports the expected collection name",
  ProgrammeStructure.collection.name === "programmestructures"
);

/* ── Summary ────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All programme structure checks passed.");
}
