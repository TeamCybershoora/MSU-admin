/**
 * Phase 5 — GATED creation of the approved uniqueness indexes.
 *
 * This script is intentionally NOT part of the implementation: it exists so the
 * schema-compatible unique constraints can be applied later, in an approved
 * environment, after the legacy preflight shows the data is safe.
 *
 * Without `--apply` it is a pure dry run: it scans the data, prints the exact
 * index definitions it would create and exits without writing anything.
 *
 * With `--apply` it refuses to run while any BLOCKING conflict exists:
 *   - duplicate enrollment numbers
 *   - duplicate university roll numbers
 *   - empty-string identifier values (the partial filter `$type: "string"`
 *     INCLUDES "" — several "" values would collide)
 * It never cleans, repairs or rewrites data to make an index succeed, and it
 * never drops an index.
 *
 * Usage:
 *   npx next start -p 3099
 *   npx tsx scripts/create-enrollment-indexes.ts            # dry run (safe)
 *   npx tsx scripts/create-enrollment-indexes.ts --apply    # ONLY with approval
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Student from "@/models/Student";
import {
  scanIdentifierConflicts,
  ENROLLMENT_INDEX_INTENT,
  type EnrollmentScanRecord,
} from "@/lib/enrollment";

const APPLY = process.argv.includes("--apply");

async function main() {
  await connectDB();

  console.log(
    `Phase 5 enrollment index script — database "${mongoose.connection.name}" — mode: ${
      APPLY ? "APPLY" : "DRY RUN (nothing will be written)"
    }\n`
  );

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
  for await (const doc of cursor) records.push(doc as EnrollmentScanRecord);
  const report = scanIdentifierConflicts(records);

  console.log(`Scanned ${report.totalStudents} student document(s).`);
  console.log(`  duplicate enrollment numbers : ${report.duplicateEnrollmentNumbers.length}`);
  console.log(`  duplicate roll numbers       : ${report.duplicateUniversityRollNumbers.length}`);
  console.log(`  empty-string identifier value: ${report.blankIdentifierValues.length}`);
  console.log(`  malformed identifier formats : ${
    report.invalidEnrollmentNumbers.length + report.invalidUniversityRollNumbers.length
  }`);
  console.log(`  other reported issues        : ${
    report.issueCount -
    report.duplicateEnrollmentNumbers.length -
    report.duplicateUniversityRollNumbers.length -
    report.blankIdentifierValues.length -
    report.invalidEnrollmentNumbers.length -
    report.invalidUniversityRollNumbers.length
  }\n`);

  const blocking =
    report.duplicateEnrollmentNumbers.length > 0 ||
    report.duplicateUniversityRollNumbers.length > 0 ||
    report.blankIdentifierValues.length > 0;

  console.log("Index definitions (ENROLLMENT_INDEX_INTENT):");
  for (const index of ENROLLMENT_INDEX_INTENT) {
    console.log(`  ${index.name}`);
    console.log(`      key     : ${JSON.stringify(index.key)}`);
    console.log(`      options : ${JSON.stringify(index.options)}`);
  }

  if (!APPLY) {
    console.log(
      "\nDRY RUN — no index was created and no record was modified." +
        (blocking
          ? "\nConflicts were found; resolve (or explicitly waive) them before applying."
          : "\nNo blocking conflict was found. Re-run with --apply ONLY with explicit authorization.") +
        "\nExisting indexes on the students collection:"
    );
    const existing = await Student.collection.indexes();
    for (const index of existing) {
      console.log(`  ${String(index.name)} : ${JSON.stringify(index.key)}`);
    }
    process.exit(0);
  }

  if (blocking) {
    console.error(
      "\nREFUSING TO APPLY: blocking conflicts exist (duplicates or empty-string identifiers)." +
        "\nNo index was created and no record was modified. Resolve the conflicts and re-run the preflight."
    );
    process.exit(1);
  }

  console.log("\nApplying the approved uniqueness indexes…");
  for (const index of ENROLLMENT_INDEX_INTENT) {
    await Student.collection.createIndex(index.key, index.options);
    console.log(`  created ${index.name}`);
  }

  const after = await Student.collection.indexes();
  console.log("\nIndexes now present on the students collection:");
  for (const index of after) {
    console.log(`  ${String(index.name)} : ${JSON.stringify(index.key)}`);
  }
  console.log(
    "\nDone. Verify in the database that no document was modified (index creation\n" +
      "does not alter documents) and record which environment this ran in."
  );

  process.exit(0);
}

main().catch((error) => {
  console.error("Index script failed:", error);
  process.exit(1);
});
