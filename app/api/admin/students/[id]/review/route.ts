import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Student, { toReviewStudent, type IStudent } from "@/models/Student";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  approvalAccountActivation,
  buildCorrectionMessage,
  buildCorrectionRequestRecord,
  buildReviewHistoryRecord,
  effectiveApplicationStatus,
  isReviewActionAllowed,
  parseApplicationStatus,
  parseCorrectionRequest,
  parseRejectionReason,
  parseReviewAction,
  targetStatusFor,
  validateRegistrationForVerification,
  type ReviewHistoryRecord,
} from "@/lib/student-review";
import { planIdentifierAssignment } from "@/lib/enrollment";
import {
  EnrollmentAbort,
  allocateMissingIdentifiers,
  createEnrollmentEvent,
  enrollmentFailureResponse,
  findStudentWithSession,
  runEnrollmentOperation,
  type IdentifierAllocationResult,
  type Session,
} from "@/lib/enrollment-service";

/**
 * POST /api/admin/students/[id]/review
 *
 * Admin/staff review of a single student application.
 *
 * Body: { action: "request_correction" | "reject" | "verify", ... }
 *   request_correction → { fields: [{ field, note? }], additionalInstructions? }
 *   reject             → { reason }
 *   verify             → (no additional fields)
 *
 * Verification (Phase 2 of the enrollment workflow) does three things as ONE
 * operation, so an application can never end up approved without them:
 *   1. pending → verified (verifiedAt / verifiedBy / review history),
 *   2. the TWO official identifiers are assigned — EN######## and
 *      MSU<admission year>###### — allocating only the ones the record is
 *      missing (an already-issued identifier is never replaced),
 *   3. an account that has not been activated yet (`pending`) becomes `active`,
 *      so the public portal agrees with the approval. A `locked` / `inactive`
 *      account is NEVER un-restricted by an approval.
 * If the identifier allocation fails, nothing is verified and the caller gets
 * the failure — the UI is never told about a success that did not happen.
 *
 * Security:
 * - Reuses authenticateAdmin() — the existing server-side authorization.
 *   Authorization is enforced here, not by hidden UI controls.
 * - Reviewer identity/role and timestamps come from the authenticated server
 *   context only; client-supplied status/reviewer/audit fields are ignored.
 * - Transitions are enforced on the server and applied with a single atomic
 *   conditional update (filtered on the expected current status), so a failed
 *   write cannot leave a partially updated application.
 * - Identifier VALUES are never accepted from the client: they come from the
 *   atomic counter allocation in @/lib/enrollment-service only.
 *
 * Protected: requires admin JWT.
 */

const reviewLimiter = createRateLimiter({
  name: "admin-student-review",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

function messageFor(action: "request_correction" | "reject" | "verify"): string {
  if (action === "request_correction") return "Correction requested.";
  if (action === "reject") return "Application rejected.";
  return "Application verified.";
}

interface VerifyContext {
  id: string;
  actorAdminId: string;
  actorRole: string;
}

type VerifyOutcome =
  | {
      kind: "verified";
      student: IStudent;
      allocation: IdentifierAllocationResult | null;
      accountActivated: boolean;
      operationId: string | null;
    }
  | { kind: "already_verified"; student: IStudent };

/**
 * Approve one application together with its official identifiers.
 *
 * Runs as ONE operation (a transaction when the deployment supports one, the
 * atomic single-document path otherwise — see @/lib/enrollment-service): the
 * status transition, the identifier allocation and the account activation are
 * applied by a single conditional update, and the audit event is appended with
 * them. Any failure aborts before/with the update, so the record is never left
 * approved without its identifiers, and no counter value is consumed in vain
 * on a transactional deployment.
 *
 * Idempotent: re-verifying (a double click, a retry, or another admin acting on
 * the same record) returns the EXISTING identifiers and allocates nothing.
 */
async function verifyApplication(ctx: VerifyContext): Promise<NextResponse> {
  try {
    const outcome = await runEnrollmentOperation<VerifyOutcome>(
      async (session: Session) => {
        const current = await findStudentWithSession(ctx.id, session);
        if (!current) {
          throw new EnrollmentAbort(404, "Student not found.");
        }

        /* Only a stored "pending" application may be verified. A legacy
         * document (no stored status) is never verified automatically —
         * it already reads as verified. */
        if (!isReviewActionAllowed("verify", current.applicationStatus)) {
          const stored = parseApplicationStatus(current.applicationStatus);
          if (stored === "verified" || stored === "enrolled") {
            const plan = planIdentifierAssignment(current);
            if (plan.ok && plan.mode === "none") {
              return { kind: "already_verified", student: current };
            }
            throw new EnrollmentAbort(
              409,
              plan.ok
                ? "This application is already approved and is only missing an official identifier. Use the Enroll action to assign the missing identifier."
                : plan.message
            );
          }
          throw new EnrollmentAbort(
            409,
            `This application is currently "${effectiveApplicationStatus(
              current.applicationStatus
            )}" and cannot receive that review action. Reload the list and try again.`
          );
        }

        /* The same registration check as before: an incomplete application is
         * never approved. */
        const problems = validateRegistrationForVerification(current);
        if (problems.length > 0) {
          throw new EnrollmentAbort(400, problems.join(" "));
        }

        /* Which official identifiers must still be generated? */
        const plan = planIdentifierAssignment(current);
        if (!plan.ok) {
          throw new EnrollmentAbort(plan.status, plan.message);
        }

        const now = new Date();
        const allocation =
          plan.mode === "none"
            ? null
            : await allocateMissingIdentifiers(plan, session);
        const activation = approvalAccountActivation(current.accountStatus);

        const setDoc: Record<string, unknown> = {
          applicationStatus: "verified",
          verifiedAt: now,
          verifiedBy: ctx.actorAdminId,
          ...(activation ?? {}),
        };
        if (allocation) {
          setDoc.enrollmentNumber = allocation.enrollmentNumber;
          setDoc.universityRollNumber = allocation.universityRollNumber;
        }

        const history: ReviewHistoryRecord = buildReviewHistoryRecord({
          action: "verify",
          fromStatus: effectiveApplicationStatus(current.applicationStatus),
          toStatus: "verified",
          reason: "",
          fields: [],
          additionalInstructions: "",
          actorId: ctx.actorAdminId,
          actorRole: ctx.actorRole,
          at: now,
        });

        /* Atomic conditional update. The filter re-asserts the exact state that
         * was read: the application must still be pending, and — when the
         * account is being activated — must still carry the account status the
         * activation was decided from, so a concurrently applied restriction is
         * never overwritten. */
        const filter: Record<string, unknown> = {
          _id: ctx.id,
          applicationStatus: "pending",
        };
        if (activation) {
          filter.accountStatus = current.accountStatus ?? null;
        }

        const updated = await Student.findOneAndUpdate(
          filter,
          { $set: setDoc, $push: { reviewHistory: history } },
          session
            ? { new: true, runValidators: true, session }
            : { new: true, runValidators: true }
        );

        if (!updated) {
          throw new EnrollmentAbort(
            409,
            "The application status changed before it could be verified. Reload and try again."
          );
        }

        const operationId = allocation
          ? await createEnrollmentEvent({
              action: "assigned_on_verification",
              studentId: updated._id,
              actorAdminId: ctx.actorAdminId,
              actorRole: ctx.actorRole,
              enrollmentNumber: allocation.enrollmentNumber,
              universityRollNumber: allocation.universityRollNumber,
              admissionYear: allocation.admissionYear,
              session,
            })
          : null;

        return {
          kind: "verified",
          student: updated,
          allocation,
          accountActivated: activation !== null,
          operationId,
        };
      }
    );

    if (outcome.kind === "already_verified") {
      return NextResponse.json({
        success: true,
        alreadyVerified: true,
        message: `This application is already verified. Enrollment number ${outcome.student.enrollmentNumber} · university roll number ${outcome.student.universityRollNumber}.`,
        student: toReviewStudent(outcome.student),
      });
    }

    const allocation = outcome.allocation;
    const parts: string[] = ["Application verified."];
    if (allocation) {
      parts.push(
        `Enrollment number ${allocation.enrollmentNumber} and university roll number ${allocation.universityRollNumber} assigned.`
      );
    } else {
      parts.push("The official identifiers were already assigned.");
    }
    if (outcome.accountActivated) {
      parts.push("The student account is now active.");
    }

    return NextResponse.json({
      success: true,
      alreadyVerified: false,
      identifiersAssigned: allocation !== null,
      accountActivated: outcome.accountActivated,
      operationId: outcome.operationId,
      message: parts.join(" "),
      student: toReviewStudent(outcome.student),
    });
  } catch (error) {
    return enrollmentFailureResponse(error, {
      messages: {
        duplicate:
          "An official identifier conflict was detected. Nothing was changed; the conflicting identifiers require manual remediation.",
        transactionUnavailable:
          "The application could not be verified safely because this database deployment does not support the required atomic operation. Nothing was changed.",
        concurrent:
          "Another request is currently verifying this student. Reload the list and try again.",
        generic: "Unable to apply the review action. Nothing was changed.",
      },
    });
  }
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (reviewLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const { id } = await ctx.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, message: "Invalid student ID format." },
        { status: 400 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, message: "Request body must be valid JSON." },
        { status: 400 }
      );
    }

    const action = parseReviewAction(
      (body as Record<string, unknown> | null)?.action
    );
    if (!action) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Action must be one of: request_correction, reject, verify.",
        },
        { status: 400 }
      );
    }

    await connectDB();

    // Verification owns the identifier allocation and the account activation,
    // so it runs as one dedicated operation (see verifyApplication).
    if (action === "verify") {
      return await verifyApplication({
        id,
        actorAdminId: auth.admin.adminId,
        actorRole: auth.admin.role,
      });
    }

    // Load once to validate the current status and (for rejection/correction)
    // the stored registration data before attempting the transition.
    const student = await Student.findById(id);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "Student not found." },
        { status: 404 }
      );
    }

    const currentStatus = effectiveApplicationStatus(student.applicationStatus);
    if (!isReviewActionAllowed(action, student.applicationStatus)) {
      return NextResponse.json(
        {
          success: false,
          message: `This application is currently "${currentStatus}" and cannot receive that review action. Reload the list and try again.`,
        },
        { status: 409 }
      );
    }

    const now = new Date();
    const targetStatus = targetStatusFor(action);

    // Only server-owned values are written. `$set` holds the status change plus
    // the fields the chosen action owns; nothing from the client is spread in.
    const setDoc: Record<string, unknown> = { applicationStatus: targetStatus };
    const history: ReviewHistoryRecord = {
      action,
      fromStatus: currentStatus,
      toStatus: targetStatus,
      reason: "",
      fields: [],
      additionalInstructions: "",
      actorId: auth.admin.adminId,
      actorRole: auth.admin.role,
      at: now,
    };

    if (action === "request_correction") {
      const parsed = parseCorrectionRequest(body);
      if (!parsed.ok) {
        return NextResponse.json(
          { success: false, message: parsed.message },
          { status: 400 }
        );
      }

      const correction = buildCorrectionRequestRecord({
        correction: parsed.value,
        actorId: auth.admin.adminId,
        actorRole: auth.admin.role,
        at: now,
      });

      setDoc.correctionRequest = correction;
      // Keep the public portal's plain-text note in sync for backward
      // compatibility. The structured request above is the source of truth.
      setDoc.correctionMessage = buildCorrectionMessage(parsed.value);
      history.fields = parsed.value.fields;
      history.additionalInstructions = parsed.value.additionalInstructions;
    } else if (action === "reject") {
      const parsed = parseRejectionReason(body);
      if (!parsed.ok) {
        return NextResponse.json(
          { success: false, message: parsed.message },
          { status: 400 }
        );
      }
      // Rejection reason is stored separately from correction data.
      setDoc.rejectionReason = parsed.value;
      history.reason = parsed.value;
    }
    // "verify" is handled by verifyApplication() above and never reaches here.

    // Atomic conditional update: the filter re-asserts the status this action
    // is allowed from, so a concurrent change makes the update a no-op.
    const updated = await Student.findOneAndUpdate(
      { _id: id, applicationStatus: "pending" },
      {
        $set: setDoc,
        $push: { reviewHistory: buildReviewHistoryRecord(history) },
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return NextResponse.json(
        {
          success: false,
          message:
            "The application status changed before this action could be applied. Reload and try again.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      message: messageFor(action),
      student: toReviewStudent(updated),
    });
  } catch (error) {
    console.error("Admin student review error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to apply the review action." },
      { status: 500 }
    );
  }
}
