/**
 * Phase 5 preflight — READ-ONLY legacy identifier diagnostic.
 *
 * Reports every conflict category that must be resolved before the approved
 * uniqueness indexes can be created, WITHOUT modifying any record:
 *   - duplicate enrollment numbers / university roll numbers
 *   - malformed enrollment numbers / university roll numbers
 *   - roll numbers whose year disagrees with the admission year
 *   - records with only one of the two identifiers
 *   - records with identifiers but a non-enrolled application status
 *   - records marked enrolled without identifiers
 *   - empty-string identifier values (these WOULD be included by the partial
 *     unique index, so duplicates of "" would block index creation)
 *   - records with no application status (legacy)
 *   - missing / invalid admission years
 *
 * It never repairs, rewrites, deletes or backfills anything, and it prints only
 * student ids and the identifiers in question — never names, emails, phone
 * numbers or other personal data.
 *
 * Usage:
 *   npx next start -p 3099          # against the target database (or use a
 *   npx tsx scripts/preflight-enrollment-identifiers.ts
 *
 * Exit code is always 0: this is a report, not a gate. The gate lives in
 * scripts/create-enrollment-indexes.ts.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Student from "@/models/Student";
import {
  scanIdentifierConflicts,
  type EnrollmentScanRecord,
} from "@/lib/enrollment";

const EXAMPLE_LIMIT = 20;

function printExamples(label: string, rows: string[]) {
  if (rows.length === 0) {
    console.log(`  ${label}: 0`);
    return;
  }
  console.log(`  ${label}: ${rows.length}`);
  rows.slice(0, EXAMPLE_LIMIT).forEach((row) => console.log(`      · ${row}`));
  if (rows.length > EXAMPLE_LIMIT) {
    console.log(`      … and ${rows.length - EXAMPLE_LIMIT} more`);
  }
}

async function main() {
  await connectDB();
  console.log(
    `Phase 5 enrollment preflight (READ-ONLY) — database "${mongoose.connection.name}"`
  );
  console.log("No record is read for personal data and no write is performed.\n");

  const cursor = Student.collection.find(
    {},
    {
      projection: {
        applicationStatus: 1,
        admissionYear: 1,
        enrollmentNumber: 1,
        universityRollNumber: 1,
      },
    }
  );

  const records: EnrollmentScanRecord[] = [];

  for await (const doc of cursor) {
    records.push(doc as EnrollmentScanRecord);
  }

  const report = scanIdentifierConflicts(records);

  console.log(`Scanned ${report.totalStudents} student document(s).\n`);

  printExamples(
    "Duplicate enrollment numbers (BLOCKS index creation)",
    report.duplicateEnrollmentNumbers.map(
      (entry) => `${entry.value} → ${entry.studentIds.join(", ")}`
    )
  );
  printExamples(
    "Duplicate university roll numbers (BLOCKS index creation)",
    report.duplicateUniversityRollNumbers.map(
      (entry) => `${entry.value} → ${entry.studentIds.join(", ")}`
    )
  );
  printExamples(
    "Empty-string identifier values (BLOCKS index creation)",
    report.blankIdentifierValues.map(
      (entry) => `${entry.field} = "" → ${entry.studentId}`
    )
  );

  console.log("");

  printExamples(
    "Invalid enrollment number formats",
    report.invalidEnrollmentNumbers.map(
      (entry) => `${entry.studentId} → "${entry.value}"`
    )
  );
  printExamples(
    "Invalid university roll number formats",
    report.invalidUniversityRollNumbers.map(
      (entry) => `${entry.studentId} → "${entry.value}"`
    )
  );
  printExamples(
    "Roll-number year ≠ admission year",
    report.rollYearMismatches.map(
      (entry) => `${entry.studentId} → ${entry.value} (admission ${entry.admissionYear})`
    )
  );
  printExamples(
    "Only one identifier present (partial)",
    report.partialIdentifiers.map(
      (entry) =>
        `${entry.studentId} → enrollment:${entry.hasEnrollmentNumber ? "yes" : "no"} roll:${
          entry.hasUniversityRollNumber ? "yes" : "no"
        }`
    )
  );
  printExamples(
    "Identifiers present but status is not 'enrolled'",
    report.identifiersWithNonEnrolledStatus.map(
      (entry) => `${entry.studentId} → status "${entry.applicationStatus ?? "none"}"`
    )
  );
  printExamples(
    "Status 'enrolled' but no identifiers",
    report.enrolledWithoutIdentifiers.map((entry) => entry.studentId)
  );
  printExamples(
    "No application status stored (legacy)",
    report.missingApplicationStatus.map((entry) => entry.studentId)
  );
  printExamples(
    "Missing / invalid admission year (where a value is present)",
    report.invalidAdmissionYears.map(
      (entry) => `${entry.studentId} → ${String(entry.admissionYear)}`
    )
  );

  console.log(
    `\nRESULT: ${report.issueCount} issue(s) across ${report.conflictingRecordCount} record(s).`
  );
  console.log(
    "No record was modified. No index was created. The approved uniqueness\n" +
      "indexes are applied only by scripts/create-enrollment-indexes.ts --apply,\n" +
      "after these conflicts are resolved or explicitly waived."
  );
  console.log(
    `\nNote: the deployed database currently enforces uniqueness only through the\natomic server-side counter allocation — DB-level unique indexes are NOT yet\ncreated (index intent: see ENROLLMENT_INDEX_INTENT in lib/enrollment.ts).`
  );

  process.exit(0);
}

main().catch((error) => {
  console.error("Preflight failed:", error);
  process.exit(1);
});
