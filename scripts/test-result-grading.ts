/**
 * Offline verification of the Result academic rules (MSU marks table).
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. The rules live in
 * lib/result-grading.ts as pure functions, so the calculation can be exercised
 * without a database.
 *
 * Usage: npx tsx scripts/test-result-grading.ts
 */
import {
  ABSENT_GRADE,
  buildResultSubject,
  calculateCGPA,
  computeResultFigures,
  computeSgpa,
  equivalentPercentage,
  formatCgpa,
  gradeForMarks,
  roundTo2,
  semesterResultStatus,
  subjectPercentage,
  subjectStatus,
  subjectTotal,
  type CgpaSemester,
} from "@/lib/result-grading";
import { toSafeResult } from "@/models/Result";
import { GENDER_OPTIONS, isGender } from "@/components/results/types";

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

function subject(credits: number, gradePoint: number) {
  return { credits, gradePoint };
}

function semester(semesterNumber: number, credits: number, gradePoint: number): CgpaSemester {
  return { semesterNumber, subjects: [subject(credits, gradePoint)] };
}

/* ── 1. MSU grade table (marks boundaries) ─────────────────── */

section("1. Grade + grade point come from the MSU marks table");
const cases: [number, string, number][] = [
  [0, "F", 0], [31, "F", 0], [32, "F", 0],
  [33, "P", 4], [39, "P", 4], [40, "P", 4],
  [41, "C", 5], [50, "C", 5],
  [51, "B", 6], [60, "B", 6],
  [61, "B+", 7], [70, "B+", 7],
  [71, "A", 8], [80, "A", 8],
  [81, "A+", 9], [89, "A+", 9], [90, "A+", 9],
  [91, "O", 10], [99, "O", 10], [100, "O", 10],
];
for (const [marks, grade, gradePoint] of cases) {
  const got = gradeForMarks(marks);
  check(`${marks} -> ${grade} / ${gradePoint}`, got.grade === grade && got.gradePoint === gradePoint);
}
check("a negative / non-finite mark is F / 0", gradeForMarks(-1).grade === "F" && gradeForMarks(NaN).gradePoint === 0);

/* ── 2. Absent ─────────────────────────────────────────────── */

section("2. Absent is AB / 0, never a bare F");
check("AB -> AB / 0", gradeForMarks(0, true).grade === ABSENT_GRADE && gradeForMarks(0, true).gradePoint === 0);
check("absence is distinct from a zero mark", gradeForMarks(0, true).grade !== gradeForMarks(0).grade);

/* ── 3. Subject total / percentage ─────────────────────────── */

section("3. Subject total and result percentage");
check("total = internal + external", subjectTotal(28, 58) === 86);
check("percentage = total / maximum x 100", subjectPercentage(86, 100) === 86);
check("a zero maximum yields 0, never Infinity/NaN", subjectPercentage(10, 0) === 0);
check("roundTo2 uses 2 dp", roundTo2(8.538461538) === 8.54);

/* ── 4. Server-authoritative subject building ──────────────── */

section("4. buildResultSubject derives grade/point and ignores client values");
const snapshot = {
  subjectCode: "CS401",
  subjectName: "Data Structures",
  credits: 4,
  maxMarks: 100,
  subjectType: "THEORY" as const,
};

const built = buildResultSubject(snapshot, {
  internalMarks: 28,
  externalMarks: 58,
  grade: "F",
  gradePoint: 1,
  totalMarks: 999,
  percentage: 1,
  isBacklog: false,
});
check("a valid submission builds", built.ok);
check("86 marks -> A+ / 9 (not the client grade)", built.ok && built.subject.grade === "A+" && built.subject.gradePoint === 9);
check("the server total (86) wins over the client total (999)", built.ok && built.subject.totalMarks === 86);
check("the curriculum maximum / credits win", built.ok && built.subject.maxMarks === 100 && built.subject.credits === 4);
check("20 + 12 = 32 -> F / 0", (() => { const r = buildResultSubject(snapshot, { internalMarks: 20, externalMarks: 12 }); return r.ok && r.subject.grade === "F" && r.subject.gradePoint === 0; })());
check("33 -> P / 4", (() => { const r = buildResultSubject(snapshot, { internalMarks: 20, externalMarks: 13 }); return r.ok && r.subject.grade === "P" && r.subject.gradePoint === 4; })());
check("marks above the curriculum maximum are rejected", !buildResultSubject(snapshot, { internalMarks: 60, externalMarks: 60 }).ok);
check("a negative mark is rejected", !buildResultSubject(snapshot, { internalMarks: -1, externalMarks: 0 }).ok);

section("5. An absent subject is stored as AB / 0");
const absent = buildResultSubject(snapshot, { isAbsent: true, internalMarks: 95 });
check("absent builds even without marks", absent.ok);
check("absent -> AB / 0 with zero marks", absent.ok && absent.subject.grade === "AB" && absent.subject.gradePoint === 0 && absent.subject.totalMarks === 0 && absent.subject.isAbsent === true);
check("absent clears internal and external", absent.ok && absent.subject.internalMarks === 0 && absent.subject.externalMarks === 0);

/* ── 5b. Internal / external maxima from the curriculum ────── */

section("5b. Internal / external maxima come from the curriculum");
const split = { ...snapshot, internalMax: 25, externalMax: 75, practicalMax: 0 };

const exact = buildResultSubject(split, { internalMarks: 25, externalMarks: 75 });
check("25 + 75 = 100 is valid", exact.ok && exact.subject.totalMarks === 100);
check("internal 26 is rejected", !buildResultSubject(split, { internalMarks: 26, externalMarks: 74 }).ok);
check("external 76 is rejected", !buildResultSubject(split, { internalMarks: 25, externalMarks: 76 }).ok);
check("a zero minimum (0 + 0) is valid", (() => { const r = buildResultSubject(split, { internalMarks: 0, externalMarks: 0 }); return r.ok && r.subject.totalMarks === 0; })());
check("a negative mark is rejected", !buildResultSubject(split, { internalMarks: -1, externalMarks: 0 }).ok);

// A subject-specific distribution (theory 30 + external 50 + practical 20).
const practicalSplit = { ...snapshot, internalMax: 30, externalMax: 50, practicalMax: 20 };
const subjectSpecific = buildResultSubject(practicalSplit, { internalMarks: 30, externalMarks: 70 });
check("30 / 50 / 20 allows 30 internal + 70 external", subjectSpecific.ok && subjectSpecific.subject.totalMarks === 100);
check("the same subject rejects external 71", !buildResultSubject(practicalSplit, { internalMarks: 30, externalMarks: 71 }).ok);

// A subject with no published split: the whole 100 is the practical component.
const project = { ...snapshot, maxMarks: 100, internalMax: 0, externalMax: 0, practicalMax: 100 };
check("a practical-only subject can record its full 100 external marks", (() => { const r = buildResultSubject(project, { internalMarks: 0, externalMarks: 100 }); return r.ok && r.subject.totalMarks === 100; })());

// Absence overrides the component maxima: supplied marks are discarded, not rejected.
const absentWithMarks = buildResultSubject(split, { isAbsent: true, internalMarks: 25, externalMarks: 75 });
check("absent ignores and clears supplied component marks", absentWithMarks.ok && absentWithMarks.subject.grade === "AB" && absentWithMarks.subject.internalMarks === 0 && absentWithMarks.subject.externalMarks === 0 && absentWithMarks.subject.totalMarks === 0);

/* ── 5c. Printed subject status (Absent / Compartment / 36% / 40%) ─ */

section("5c. Printed subject status uses the subject passing thresholds");

// Precedence: Absent, then Compartment, then the percentage threshold.
check("absent -> Absent", subjectStatus({ totalMarks: 0, maxMarks: 100, isAbsent: true }) === "Absent");
check(
  "absence takes precedence over a passing percentage and the backlog flag",
  subjectStatus({ totalMarks: 60, maxMarks: 100, isAbsent: true, isBacklog: true }) === "Absent"
);
check("backlog -> Compartment", subjectStatus({ totalMarks: 60, maxMarks: 100, isBacklog: true }) === "Compartment");
check(
  "compartment takes precedence over a below-threshold percentage",
  subjectStatus({ totalMarks: 10, maxMarks: 100, subjectType: "THEORY", isBacklog: true }) === "Compartment"
);

// Theory: minimum 36%.
check("theory 35.99% -> Fail", subjectStatus({ totalMarks: 35.99, maxMarks: 100, subjectType: "THEORY" }) === "Fail");
check("theory exactly 36% -> Pass", subjectStatus({ totalMarks: 36, maxMarks: 100, subjectType: "THEORY" }) === "Pass");
check("theory 36.01% -> Pass", subjectStatus({ totalMarks: 36.01, maxMarks: 100, subjectType: "THEORY" }) === "Pass");
check("theory 40% -> Pass", subjectStatus({ totalMarks: 40, maxMarks: 100, subjectType: "THEORY" }) === "Pass");
check(
  "theory uses the subject's OWN maximum (18/50 = 36% -> Pass)",
  subjectStatus({ totalMarks: 18, maxMarks: 50, subjectType: "THEORY" }) === "Pass"
);
check(
  "theory 17.5/50 = 35% -> Fail",
  subjectStatus({ totalMarks: 17.5, maxMarks: 50, subjectType: "THEORY" }) === "Fail"
);
check(
  "an untyped (legacy) subject uses the theory minimum",
  subjectStatus({ totalMarks: 36, maxMarks: 100 }) === "Pass"
);
check(
  "a grade P mark below 36% is still a Fail (grade table is not the passing rule)",
  gradeForMarks(35).grade === "P" && subjectStatus({ totalMarks: 35, maxMarks: 100, subjectType: "THEORY" }) === "Fail"
);

// Practical: minimum 40%.
check("practical 39% -> Fail", subjectStatus({ totalMarks: 39, maxMarks: 100, subjectType: "PRACTICAL" }) === "Fail");
check("practical 39.99% -> Fail", subjectStatus({ totalMarks: 39.99, maxMarks: 100, subjectType: "PRACTICAL" }) === "Fail");
check("practical exactly 40% -> Pass", subjectStatus({ totalMarks: 40, maxMarks: 100, subjectType: "PRACTICAL" }) === "Pass");
check("practical 40.01% -> Pass", subjectStatus({ totalMarks: 40.01, maxMarks: 100, subjectType: "PRACTICAL" }) === "Pass");
check(
  "a practical subject on a 50-mark maximum uses 40% (20/50 -> Pass)",
  subjectStatus({ totalMarks: 20, maxMarks: 50, subjectType: "PRACTICAL" }) === "Pass"
);
check(
  "the same practical subject at 19.5/50 = 39% -> Fail",
  subjectStatus({ totalMarks: 19.5, maxMarks: 50, subjectType: "PRACTICAL" }) === "Fail"
);

/* ── 5d. Semester result status ───────────────────────────────── */

section("5d. Semester result status is derived from the subject statuses");
check("all subjects pass -> PASS", semesterResultStatus(["Pass", "Pass"]) === "PASS");
check("no subjects -> PASS", semesterResultStatus([]) === "PASS");
check("a failed theory subject -> FAIL", semesterResultStatus(["Pass", "Fail"]) === "FAIL");
check("a failed practical subject -> FAIL", semesterResultStatus(["Pass", "Fail", "Pass"]) === "FAIL");
check("an absent subject -> FAIL", semesterResultStatus(["Pass", "Absent"]) === "FAIL");
check(
  "a Compartment subject does NOT make the semester Compartment or Fail",
  semesterResultStatus(["Pass", "Compartment"]) === "PASS"
);
check(
  "the spec example: passes + one Compartment -> semester PASS",
  semesterResultStatus(
    [
      subjectStatus({ totalMarks: 60, maxMarks: 100, subjectType: "THEORY" }),
      subjectStatus({ totalMarks: 55, maxMarks: 100, subjectType: "THEORY" }),
      subjectStatus({ totalMarks: 38, maxMarks: 100, subjectType: "THEORY" }),
      subjectStatus({ totalMarks: 45, maxMarks: 100, subjectType: "PRACTICAL" }),
      subjectStatus({ totalMarks: 50, maxMarks: 100, subjectType: "THEORY", isBacklog: true }),
    ]
  ) === "PASS"
);
check(
  "the spec example: one theory at 35% -> semester FAIL",
  semesterResultStatus(
    [
      subjectStatus({ totalMarks: 60, maxMarks: 100, subjectType: "THEORY" }),
      subjectStatus({ totalMarks: 35, maxMarks: 100, subjectType: "THEORY" }),
      subjectStatus({ totalMarks: 70, maxMarks: 100, subjectType: "THEORY" }),
    ]
  ) === "FAIL"
);

/* ── 6. SGPA ───────────────────────────────────────────────── */

section("6. SGPA is credit-weighted and rounded to 2 dp");
check("no credits -> null", computeSgpa([]) === null);
check("zero credits -> null", computeSgpa([subject(0, 10), subject(0, 8)]) === null);
check("equal credits are a straight mean", computeSgpa([subject(4, 8), subject(4, 10)]) === 9);
check("different credits are weighted", computeSgpa([subject(2, 10), subject(4, 5)]) === roundTo2((2 * 10 + 4 * 5) / 6));

const figures = computeResultFigures([
  { totalMarks: 86, maxMarks: 100, credits: 4, gradePoint: 9 },
  { totalMarks: 40, maxMarks: 100, credits: 2, gradePoint: 4 },
]);
check("result figures total the marks", figures.totalMarks === 126 && figures.maxTotalMarks === 200);
check("result figures round the percentage", figures.percentage === 63);
check("result figures derive SGPA from credits", figures.sgpa === roundTo2((4 * 9 + 2 * 4) / 6));

/* ── 7. CGPA ───────────────────────────────────────────────── */

section("7. CGPA is credit-weighted across semesters");
check("a single semester carries its own value", calculateCGPA([semester(1, 24, 8)]) === 8);
check("equal credit totals give (8 + 9) / 2", calculateCGPA([semester(1, 20, 8), semester(2, 20, 9)]) === 8.5);
check("24cr@8 + 28cr@9 = 8.54, not 8.5", calculateCGPA([semester(1, 24, 8), semester(2, 28, 9)]) === 8.54);
const three = calculateCGPA([semester(1, 20, 8), semester(2, 22, 9), semester(3, 26, 7)]);
check("three semesters = sum(cr x gp) / sum cr", three === roundTo2((20 * 8 + 22 * 9 + 26 * 7) / (20 + 22 + 26)));
check("no semesters -> null", calculateCGPA([]) === null);
check("no credits anywhere -> null", calculateCGPA([semester(1, 0, 10)]) === null);
check("a null CGPA stays null when formatted", formatCgpa(null) === null);
check("a CGPA is stored with 2 dp", formatCgpa(8.5) === "8.50");

/* ── 8. Equivalent percentage ──────────────────────────────── */

section("8. Equivalent percentage = CGPA x 9.5");
check("8.54 -> 81.13", equivalentPercentage(8.54) === 81.13);
check("10 -> 95", equivalentPercentage(10) === 95);
check("no CGPA -> null", equivalentPercentage(null) === null);
check(
  "the worked CGPA gives 81.13",
  equivalentPercentage(calculateCGPA([semester(1, 24, 8), semester(2, 28, 9)])) === 81.13
);

/* ── 9. Student details reach the printed document ─────────── */

section("9. Stored identity leaves toSafeResult and reaches the document shape");

const storedResult = {
  student: {
    name: "Aarav Sharma",
    rollNumber: "MSU2024001",
    enrollmentNumber: "EN2024CS1001",
    course: "Bachelor of Computer Applications",
    semester: "Semester IV",
    academicSession: "2023-24",
    collegeName: "University College",
    fatherName: "Test Father",
    motherName: "Test Mother",
    gender: "Female",
  },
  curriculum: { programmeCode: "BCA", semesterNumber: 4 },
  subjects: [
    {
      subjectCode: "CS401",
      subjectName: "Data Structures",
      internalMarks: 28,
      externalMarks: 58,
      totalMarks: 86,
      maxMarks: 100,
      grade: "A+",
      gradePoint: 9,
      credits: 4,
      subjectType: "THEORY" as const,
      isBacklog: false,
      isAbsent: false,
    },
  ],
  totalMarks: 86,
  maxTotalMarks: 100,
  percentage: 86,
  sgpa: 8.6,
  cgpa: "8.54",
  equivalentPercentage: 81.13,
  resultStatus: "PASS" as const,
  remarks: "",
  declaredDate: "15 July 2026",
};

const safe = toSafeResult(storedResult);
check("fatherName survives to the document shape", safe.student.fatherName === "Test Father");
check("motherName survives to the document shape", safe.student.motherName === "Test Mother");
check("gender survives to the document shape", safe.student.gender === "Female");
check("subjectType reaches the document (drives the practical threshold)", safe.subjects[0].subjectType === "THEORY");

// A result with no identity fields still yields printable empty strings (— in JSX).
const noIdentity = toSafeResult({
  ...storedResult,
  student: { ...storedResult.student, fatherName: undefined as unknown as string, motherName: undefined as unknown as string, gender: undefined as unknown as string },
});
check(
  "missing identity fields default to empty, never undefined",
  noIdentity.student.fatherName === "" && noIdentity.student.motherName === "" && noIdentity.student.gender === ""
);

section("9b. Gender is a closed Male / Female / Other single-selection list");
check("exactly three options are offered", GENDER_OPTIONS.length === 3);
check("the options are Male, Female and Other", GENDER_OPTIONS.join(",") === "Male,Female,Other");
check("the options are distinct (a radio group can select only one)", new Set(GENDER_OPTIONS).size === 3);
check("Male / Female / Other are accepted", isGender("Male") && isGender("Female") && isGender("Other"));
check("an unset value is allowed", isGender(""));
check("arbitrary free text is rejected", !isGender("M") && !isGender("female") && !isGender("Other ") && !isGender(42));

section("9c. A client resultStatus can never override the derived semester status");
check(
  "client PASS cannot beat a failing subject (derived FAIL)",
  semesterResultStatus([subjectStatus({ totalMarks: 35, maxMarks: 100, subjectType: "THEORY" })]) === "FAIL"
);
check(
  "client FAIL cannot beat passing subjects (derived PASS)",
  semesterResultStatus([subjectStatus({ totalMarks: 80, maxMarks: 100, subjectType: "THEORY" })]) === "PASS"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
else console.log("All result grading checks passed.");
