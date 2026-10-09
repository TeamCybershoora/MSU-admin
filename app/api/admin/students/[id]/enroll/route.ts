import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Student, { toReviewStudent, type IStudent } from "@/models/Student";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { decideEnrollment } from "@/lib/enrollment";
import {
  assignMissingIdentifiers,
  enrollmentFailureResponse,
} from "@/lib/enrollment-service";

/**
 * POST /api/admin/students/[id]/enroll
 *
 * Assign the official identifiers of an APPROVED student.
 *
 * Since verification already assigns both identifiers
 * (app/api/admin/students/[id]/review, action "verify"), this endpoint's job is
 * the SAFE REPAIR path: an approved record missing one or both identifiers gets
 * exactly the missing one(s) allocated here. It is also the guard that refuses
 * records which must not be touched.
 *
 * Guarantees (see @/lib/enrollment-service for the implementation)
 * ----------
 * - Authorization reuses the existing admin policy (authenticateAdmin):
 *   any ACTIVE admin may enroll. There is no Staff role and no new permission
 *   system. Authorization is enforced here — never by hidden UI controls.
 * - This endpoint reads NO request body at all, so client-supplied
 *   applicationStatus / accountStatus / enrollmentNumber / universityRollNumber
 *   / enrolledAt / enrolledBy / verified* / counter / sequence / reviewer /
 *   audit values cannot influence the result.
 * - Eligibility is re-checked from the CURRENT database record immediately
 *   before allocation, and the write is a single conditional update filtered on
 *   `applicationStatus: "verified"` plus the EXACT identifier state that was
 *   read — a concurrent enrollment or a stale request cannot overwrite or
 *   duplicate an assignment, and only the missing fields are written.
 * - Identifiers come from the atomic counter allocation, never from the client.
 * - Idempotent: an approved record that already carries two valid, consistent
 *   identifiers returns the EXISTING identifiers, allocates nothing and creates
 *   no second event. Malformed / contradictory identifiers are rejected (409)
 *   for manual remediation and never completed or replaced.
 * - `accountStatus`: an approval activates an account that was still `pending`
 *   (never one that is `locked` / `inactive`), so the public portal agrees with
 *   the admin decision.
 * - Phase 4 review history, correction requests and rejection data are
 *   preserved untouched; this route appends nothing to `reviewHistory` (the
 *   audit record lives in EnrollmentEvent instead).
 */

const enrollLimiter = createRateLimiter({
  name: "admin-student-enroll",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Re-read the record and report it only when it is genuinely enrolled. */
async function reReadEnrolled(studentId: string | null): Promise<IStudent | null> {
  if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) return null;

  const student = await Student.findById(studentId);
  if (!student) return null;

  const decision = decideEnrollment(student);
  return decision.ok && decision.mode === "already_enrolled" ? student : null;
}

function alreadyEnrolledResponse(student: IStudent) {
  return NextResponse.json({
    success: true,
    alreadyEnrolled: true,
    repaired: false,
    message:
      "This student is already enrolled. The existing official identifiers were returned unchanged.",
    student: toReviewStudent(student),
  });
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (enrollLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let studentId: string | null = null;

  try {
    const { id } = await ctx.params;
    studentId = id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, message: "Invalid student ID format." },
        { status: 400 }
      );
    }

    await connectDB();

    const outcome = await assignMissingIdentifiers({
      studentId: id,
      actorAdminId: auth.admin.adminId,
      actorRole: auth.admin.role,
      action: "enrolled",
    });

    if (outcome.kind === "already_complete") {
      return alreadyEnrolledResponse(outcome.student);
    }

    /* A single identifier was already issued and the other was just allocated:
     * that is a repair, not a first enrollment. */
    const repaired =
      !outcome.allocation.assignedEnrollmentNumber ||
      !outcome.allocation.assignedUniversityRollNumber;

    return NextResponse.json({
      success: true,
      alreadyEnrolled: false,
      repaired,
      operationId: outcome.operationId,
      message: repaired
        ? `Missing identifier assigned. Enrollment number ${outcome.allocation.enrollmentNumber} · university roll number ${outcome.allocation.universityRollNumber}.`
        : `Student enrolled. Enrollment number ${outcome.allocation.enrollmentNumber} · university roll number ${outcome.allocation.universityRollNumber}.`,
      student: toReviewStudent(outcome.student),
    });
  } catch (error) {
    return enrollmentFailureResponse(error, {
      studentId,
      messages: {
        duplicate:
          "An official identifier conflict was detected. Nothing was changed; the conflicting identifiers require manual remediation.",
        transactionUnavailable:
          "The identifier assignment could not be completed safely because this database deployment does not support the required atomic operation. Nothing was changed.",
        concurrent:
          "Another request is currently assigning identifiers to this student. Reload the list and try again.",
        generic: "Unable to enroll the student. Nothing was changed.",
      },
      onDuplicateKey: async (id) => {
        const existing = await reReadEnrolled(id);
        return existing ? alreadyEnrolledResponse(existing) : null;
      },
    });
  }
}
