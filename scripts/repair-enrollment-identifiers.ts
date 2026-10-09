/**
 * Phase 4 — repair the official identifiers of ALREADY-APPROVED students.
 *
 * Background: before verification assigned identifiers automatically, an admin
 * could approve an application that then received no enrollment number and no
 * university roll number. This script finds those records and assigns exactly
 * the identifier(s) they are missing — nothing else.
 *
 * Usage
 * -----
 *   npx tsx scripts/repair-enrollment-identifiers.ts                 # DRY RUN
 *   npx tsx scripts/repair-enrollment-identifiers.ts --apply --actor <adminId>
 *   npx tsx scripts/repair-enrollment-identifiers.ts --apply --actor <adminId> \
 *       --student <studentId>
 *
 * Safety
 * ------
 * - DRY RUN by default: without `--apply` NOTHING is written, no counter is
 *   advanced and the script only reports what it would do.
 * - `--apply` additionally requires `--actor <adminId>`: a real, ACTIVE admin
 *   account that the appended EnrollmentEvent audit record can name. There is
 *   no anonymous write path.
 * - Only records whose STORED applicationStatus is `verified` or `enrolled` are
 *   considered. Pending / needs_correction / rejected applications are never
 *   touched, and neither are legacy documents that carry no application status
 *   at all (they read as approved at read time, but "no stored decision" is not
 *   a decision to act on).
 * - An identifier that is already issued is PRESERVED: only the missing one is
 *   allocated, from the same atomic per-admission-year / global sequences the
 *   live endpoints use, so no duplicate can be created and the admission year
 *   rule is respected.
 * - Every repair reuses the production operation (@/lib/enrollment-service), so
 *   it is a single conditional update with the same eligibility re-check. A
 *   record that changed underneath is skipped, never overwritten.
 * - Idempotent: a second run finds nothing to repair and allocates nothing.
 * - The report prints student ids, statuses and the official identifiers only —
 *   never names, emails, phone numbers, Aadhar or ABC ids.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Student, { type IStudent } from "@/models/Student";
import Admin from "@/models/Admin";
import { decideEnrollment } from "@/lib/enrollment";
import { assignMissingIdentifiers } from "@/lib/enrollment-service";

const argv = process.argv.slice(2);

function flagValue(name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const APPLY = argv.includes("--apply");
const ACTOR_ID = flagValue("--actor");
const ONLY_STUDENT = flagValue("--student");

interface Report {
  examined: number;
  candidates: { id: string; identifiers: { enrollment: boolean; roll: boolean } }[];
  repaired: { id: string; enrollmentNumber: string; universityRollNumber: string }[];
  alreadyComplete: string[];
  skipped: { id: string; code: string; message: string }[];
  failed: { id: string; message: string }[];
  legacyWithoutStatus: number;
  unapproved: number;
}

async function main() {
  await connectDB();
  console.log(
    `Phase 4 identifier repair — database "${mongoose.connection.name}"`
  );

  if (!APPLY) {
    console.log(
      "DRY RUN: nothing will be written. Re-run with --apply --actor <adminId> to repair.\n"
    );
  }

  /* Resolve and validate the audit identity BEFORE touching anything. */
  let actorId = "";
  if (APPLY) {
    if (!ONLY_STUDENT) {
      console.log(
        "Note: this run covers every approved student with a missing identifier.\n"
      );
    }
    if (!ACTOR_ID || !mongoose.Types.ObjectId.isValid(ACTOR_ID)) {
      throw new Error(
        "--apply requires --actor <adminId> (a real active admin account recorded on the audit event)."
      );
    }
    const actor = await Admin.findById(ACTOR_ID).select("status role");
    if (!actor) throw new Error("The --actor admin account was not found.");
    if ((actor.status ?? "active") !== "active") {
      throw new Error("The --actor admin account is inactive.");
    }
    actorId = ACTOR_ID;
    console.log(`Audit actor: ${actorId} (role ${actor.role ?? "unknown"})\n`);
  }

  const query = ONLY_STUDENT
    ? { _id: ONLY_STUDENT }
    : { applicationStatus: { $in: ["verified", "enrolled"] } };

  const students = await Student.find(query).sort({ createdAt: 1 });

  const report: Report = {
    examined: students.length,
    candidates: [],
    repaired: [],
    alreadyComplete: [],
    skipped: [],
    failed: [],
    legacyWithoutStatus: 0,
    unapproved: 0,
  };

  /* Counted separately so the report explains what was deliberately NOT
   * considered (these are never loaded field-by-field). */
  if (!ONLY_STUDENT) {
    report.legacyWithoutStatus = await Student.countDocuments({
      $or: [
        { applicationStatus: { $exists: false } },
        { applicationStatus: null },
      ],
    });
    report.unapproved = await Student.countDocuments({
      applicationStatus: { $in: ["pending", "needs_correction", "rejected"] },
    });
  }

  for (const student of students as IStudent[]) {
    const id = String(student._id);
    const decision = decideEnrollment(student);

    if (decision.ok && decision.mode === "already_enrolled") {
      report.alreadyComplete.push(id);
      continue;
    }

    if (!decision.ok) {
      report.skipped.push({
        id,
        code: decision.code,
        message: decision.message,
      });
      continue;
    }

    report.candidates.push({
      id,
      identifiers: {
        enrollment: decision.allocate !== "both" && decision.allocate !== "roll",
        roll: decision.allocate !== "both" && decision.allocate !== "enrollment",
      },
    });

    if (!APPLY) {
      console.log(
        `  WOULD REPAIR ${id} → allocate ${
          decision.allocate === "both"
            ? "enrollment number + university roll number"
            : decision.allocate === "roll"
              ? "university roll number (enrollment number preserved)"
              : "enrollment number (university roll number preserved)"
        }`
      );
      continue;
    }

    try {
      const outcome = await assignMissingIdentifiers({
        studentId: id,
        actorAdminId: actorId,
        actorRole: "repair-script",
        action: "enrolled",
      });

      if (outcome.kind === "already_complete") {
        report.alreadyComplete.push(id);
        console.log(`  SKIP   ${id} — both identifiers were already present.`);
        continue;
      }

      report.repaired.push({
        id,
        enrollmentNumber: outcome.allocation.enrollmentNumber,
        universityRollNumber: outcome.allocation.universityRollNumber,
      });
      console.log(
        `  REPAIRED ${id} → ${outcome.allocation.enrollmentNumber} / ${outcome.allocation.universityRollNumber}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ id, message });
      console.error(`  FAILED ${id} — ${message}`);
    }
  }

  console.log("\nSummary");
  console.log(`  students examined:          ${report.examined}`);
  console.log(`  missing an identifier:      ${report.candidates.length}`);
  console.log(
    `  ${APPLY ? "repaired:                  " : "would be repaired:         "} ${APPLY ? report.repaired.length : report.candidates.length}`
  );
  console.log(`  already complete (skipped): ${report.alreadyComplete.length}`);
  console.log(`  skipped (never eligible):   ${report.skipped.length}`);
  console.log(`  failed:                     ${report.failed.length}`);
  if (!ONLY_STUDENT) {
    console.log(
      `  not considered — no stored application status (legacy): ${report.legacyWithoutStatus}`
    );
    console.log(
      `  not considered — not approved (pending / correction / rejected): ${report.unapproved}`
    );
  }

  if (report.skipped.length > 0) {
    console.log("\nSkipped records and the reason:");
    report.skipped.forEach((entry) =>
      console.log(`      · ${entry.id} [${entry.code}] ${entry.message}`)
    );
  }

  if (!APPLY) {
    console.log(
      "\nNo record was modified. Run again with --apply --actor <adminId> to apply these repairs."
    );
    process.exit(0);
  }

  if (report.failed.length > 0) {
    console.error("\nAt least one repair failed — see the FAILED lines above.");
    process.exit(1);
  }

  console.log("\nDone. No further action is required for the reported records.");
  process.exit(0);
}

main().catch((error) => {
  console.error(
    "Repair run failed:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
