/**
 * Offline verification of the Result academic rules (Phase 3B + 3C).
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. The rules live in
 * lib/result-grading.ts as pure functions, so the calculation can be exercised
 * without a database.
 *
 * Coverage:
 *   1. grade point bands (raw percentage, never the letter grade)
 *   2. subject total / percentage
 *   3. server-authoritative subject building (client figures ignored)
 *   4. SGPA (credit-weighted, 2 dp)
 *   5. CGPA — equal credits (weighting is equivalent to the mean)
 *   6. CGPA — different credits (NOT a simple average of SGPAs)
 *   7. CGPA — the worked example (24cr@8 + 28cr@9 → 8.54)
 *   8. CGPA — going forward vs. updating an earlier semester
 *   9. empty / no-credit guards
 *
 * Usage: npx tsx scripts/test-result-grading.ts
 */
import {
  buildResultSubject,
  calculateCGPA,
  computeResultFigures,
  computeSgpa,
  formatCgpa,
  gradePointForPercentage,
  roundTo2,
  subjectPercentage,
  subjectTotal,
  type CgpaSemester,
} from "@/lib/result-grading";

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

/** One subject's contribution: `credits` at grade point `gradePoint`. */
function subject(credits: number, gradePoint: number) {
  return { credits, gradePoint };
}

/** A semester made of `credits` at a single grade point. */
function semester(semesterNumber: number, credits: number, gradePoint: number): CgpaSemester {
  return { semesterNumber, subjects: [subject(credits, gradePoint)] };
}

/* ── 1. Grade point bands ──────────────────────────────────── */

section("1. Grade points come from the raw percentage");

check("90.0 → 10", gradePointForPercentage(90) === 10);
check("89.9 → 9", gradePointForPercentage(89.9) === 9);
check("80.0 → 9", gradePointForPercentage(80) === 9);
check("70.0 → 8", gradePointForPercentage(70) === 8);
check("60.0 → 7", gradePointForPercentage(60) === 7);
check("50.0 → 6", gradePointForPercentage(50) === 6);
check("40.0 → 5", gradePointForPercentage(40) === 5);
check("39.9 → 0 (fail)", gradePointForPercentage(39.9) === 0);
check("a negative / non-finite percentage is 0", gradePointForPercentage(-1) === 0 && gradePointForPercentage(NaN) === 0);

/* ── 2. Subject total / percentage ─────────────────────────── */

section("2. Subject total and percentage");

check("total = internal + external", subjectTotal(28, 58) === 86);
check("percentage = total / maximum × 100", subjectPercentage(86, 100) === 86);
check("a zero maximum yields 0, never Infinity/NaN", subjectPercentage(10, 0) === 0);
check("roundTo2 uses 2 dp", roundTo2(8.538461538) === 8.54);

/* ── 3. Server-authoritative subject building ──────────────── */

section("3. Client figures are ignored when building a subject");

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
  grade: "A",
  gradePoint: 1, // client junk — must be ignored
  totalMarks: 999, // client junk — must be ignored
  percentage: 99, // client junk — must be ignored
  isBacklog: false,
});

check("a valid submission builds", built.ok);
check(
  "the total, maximum, credits and grade point are server-calculated",
  built.ok &&
    built.subject.totalMarks === 86 &&
    built.subject.maxMarks === 100 &&
    built.subject.credits === 4 &&
    built.subject.gradePoint === 9 &&
    built.subject.subjectName === "Data Structures"
);
check("the manual letter grade passes through untouched", built.ok && built.subject.grade === "A");
check(
  "marks above the curriculum maximum are rejected",
  !buildResultSubject(snapshot, { internalMarks: 60, externalMarks: 60, grade: "A" }).ok
);

/* ── 4. SGPA ───────────────────────────────────────────────── */

section("4. SGPA is credit-weighted and rounded to 2 dp");

check("no credits → null", computeSgpa([]) === null);
check("zero credits → null", computeSgpa([subject(0, 10), subject(0, 8)]) === null);
check(
  "equal credits are a straight mean",
  computeSgpa([subject(4, 8), subject(4, 10)]) === 9
);
check(
  "different credits are weighted",
  computeSgpa([subject(2, 10), subject(4, 5)]) === roundTo2((2 * 10 + 4 * 5) / 6)
);

const figures = computeResultFigures([
  { totalMarks: 86, maxMarks: 100, credits: 4, gradePoint: 9 },
  { totalMarks: 40, maxMarks: 100, credits: 2, gradePoint: 5 },
]);
check("result figures total the marks", figures.totalMarks === 126 && figures.maxTotalMarks === 200);
check("result figures round the percentage", figures.percentage === 63);
check("result figures derive SGPA from credits", figures.sgpa === roundTo2((4 * 9 + 2 * 5) / 6));

/* ── 5–7. CGPA ─────────────────────────────────────────────── */

section("5. One semester: CGPA equals that semester's SGPA");

check("a single semester carries its own value forward", calculateCGPA([semester(1, 24, 8)]) === 8);

section("6. Equal credits: weighting matches the simple mean");

const equalCredits = calculateCGPA([semester(1, 20, 8), semester(2, 20, 9)]);
check("equal credit totals give (8 + 9) / 2", equalCredits === 8.5);

section("7. Different credits: NOT a simple average of SGPAs");

const unequalCredits = calculateCGPA([semester(1, 24, 8), semester(2, 28, 9)]);
check("the weighted figure is 8.54, not 8.5", unequalCredits === 8.54);
check("the simple average would have been 8.5 (proving the difference)", unequalCredits !== 8.5);

section("8. Three semesters accumulate every included credit");

const threeSemesters = calculateCGPA([
  semester(1, 20, 8),
  semester(2, 22, 9),
  semester(3, 26, 7),
]);
check(
  "three semesters = Σ(cr × gp) / Σ cr",
  threeSemesters === roundTo2((20 * 8 + 22 * 9 + 26 * 7) / (20 + 22 + 26))
);

section("9. Updating an earlier semester changes the cumulative value");

const beforeRetake = calculateCGPA([semester(1, 24, 8), semester(2, 28, 9)]);
const afterRetake = calculateCGPA([semester(1, 24, 10), semester(2, 28, 9)]);
check("the cumulative value changes when semester 1 changes", beforeRetake !== afterRetake);
check(
  "the recomputed value uses the new semester-1 credits/points",
  afterRetake === roundTo2((24 * 10 + 28 * 9) / 52)
);

/* ── 10. Guards + storage format ───────────────────────────── */

section("10. Guards and the stored format");

check("no semesters → null", calculateCGPA([]) === null);
check("no credits anywhere → null", calculateCGPA([semester(1, 0, 10)]) === null);
check("a null CGPA stays null when formatted", formatCgpa(null) === null);
check("a CGPA is stored with 2 dp", formatCgpa(8.5) === "8.50");
check("the worked example stores as 8.54", formatCgpa(calculateCGPA([semester(1, 24, 8), semester(2, 28, 9)])) === "8.54");

/* ── Summary ────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All result grading checks passed.");
}
