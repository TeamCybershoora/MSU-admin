import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Enquiry, { toSafeEnquiry, type EnquirySource } from "@/models/Enquiry";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { getEnquiryAuditHistory, recordEnquiryAudit } from "@/lib/enquiry-audit";
import {
  allowedTransitions,
  canTransition,
  parseEnquiryReferenceParam,
  validateClassificationInput,
  validateStatusInput,
} from "@/lib/enquiry-validation";

/**
 * /api/admin/enquiries/[id] — one enquiry, addressed by its PUBLIC REFERENCE.
 *
 * The `[id]` segment is the human-facing reference (e.g. MSU-ENQ-48J7PRKQ), not
 * the MongoDB ObjectId. That keeps URLs readable, keeps forbidden internal ids
 * out of the browser, and — most importantly — keeps the audit trail usable
 * after a deletion, because the reference survives the document.
 *
 * GET    — full detail + audit history. Records an `enquiry.viewed` audit entry
 *          because this is the one response that contains submitter PII.
 * PATCH  — update the enquiry. Body: { status? , classification? } — at least
 *          one is required. `status` follows the status workflow; `classification`
 *          is the OPTIONAL admin classification of a GENERAL enquiry ("" clears
 *          it). Every other field is ignored.
 * DELETE — permanently remove the enquiry, after which an `enquiry.deleted`
 *          audit entry preserves who removed it and under which reference.
 *
 * Authentication: any active admin (authenticateAdmin) — on every verb.
 * Rate limited: read 60, mutation 30 per 15 min.
 *
 * Every value the response relies on comes from the database, never from the
 * client: the caller supplies only the reference (validated) and, for PATCH, the
 * target status (validated against the enum and against the transition rules).
 */

const enquiryReadLimiter = createRateLimiter({
  name: "admin-enquiry-detail",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

const enquiryMutationLimiter = createRateLimiter({
  name: "admin-enquiry-mutation",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

function rateLimited() {
  return NextResponse.json(
    { success: false, message: "Too many requests. Please try again later." },
    { status: 429 }
  );
}

function invalidReference() {
  return NextResponse.json(
    { success: false, message: "Invalid enquiry reference." },
    { status: 400 }
  );
}

function notFound() {
  return NextResponse.json(
    { success: false, message: "Enquiry not found." },
    { status: 404 }
  );
}

/* ── GET — full detail + audit history ─────────────────────────── */

export async function GET(req: Request, ctx: RouteContext) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (enquiryReadLimiter.check(req)) return rateLimited();

  const { id } = await ctx.params;
  const reference = parseEnquiryReferenceParam(id);
  if (!reference) return invalidReference();

  try {
    await connectDB();

    const enquiry = await Enquiry.findOne({ reference }).lean();
    if (!enquiry) return notFound();

    // This response contains the submitter's contact details and message, so
    // the read itself is audited. Fire-and-forget by design: recordEnquiryAudit
    // never throws, and a logging failure must not block the enquiry from being
    // displayed.
    await recordEnquiryAudit({
      action: "enquiry.viewed",
      actorAdminId: auth.admin.adminId,
      reference,
      enquiryId: String((enquiry as { _id?: unknown })._id ?? ""),
    });

    const auditLog = await getEnquiryAuditHistory(reference);

    return NextResponse.json({
      success: true,
      data: {
        enquiry: toSafeEnquiry(enquiry as unknown as EnquirySource),
        auditLog,
      },
    });
  } catch (error) {
    console.error("Admin enquiry detail error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load the enquiry." },
      { status: 500 }
    );
  }
}

/* ── PATCH — status transition and/or classification ──────────── */

export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (enquiryMutationLimiter.check(req)) return rateLimited();

  const { id } = await ctx.params;
  const reference = parseEnquiryReferenceParam(id);
  if (!reference) return invalidReference();

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { success: false, message: "Invalid request body." },
        { status: 400 }
      );
    }

    const payload = body as Record<string, unknown>;
    const wantsStatus = "status" in payload;
    const wantsClassification = "classification" in payload;

    if (!wantsStatus && !wantsClassification) {
      return NextResponse.json(
        { success: false, message: "Provide a status or classification to update." },
        { status: 400 }
      );
    }

    // Both values are validated BEFORE the database is touched. The
    // classification is validated against the allowed slug list, so a
    // client-invented value can never be stored.
    const parsedStatus = wantsStatus
      ? validateStatusInput(payload.status)
      : null;
    if (parsedStatus && !parsedStatus.ok) {
      return NextResponse.json(
        { success: false, message: parsedStatus.message },
        { status: 400 }
      );
    }

    const parsedClassification = wantsClassification
      ? validateClassificationInput(payload.classification)
      : null;
    if (parsedClassification && !parsedClassification.ok) {
      return NextResponse.json(
        { success: false, message: parsedClassification.message },
        { status: 400 }
      );
    }

    await connectDB();

    const enquiry = await Enquiry.findOne({ reference });
    if (!enquiry) return notFound();

    const previousStatus = enquiry.status;

    if (parsedStatus) {
      // Enforced server-side: the UI only offers legal targets, but the API is
      // the authority. Setting the current status again is not a transition.
      if (!canTransition(previousStatus, parsedStatus.value)) {
        const allowed = allowedTransitions(previousStatus);
        return NextResponse.json(
          {
            success: false,
            message: allowed.length
              ? `Cannot change status from "${previousStatus}" to "${parsedStatus.value}". Allowed: ${allowed.join(", ")}.`
              : `"${previousStatus}" is already the current status.`,
          },
          { status: 400 }
        );
      }
    }

    if (parsedClassification && enquiry.type !== "general") {
      return NextResponse.json(
        {
          success: false,
          message: "Classification applies to general enquiries only.",
        },
        { status: 400 }
      );
    }

    const previousClassification = enquiry.generalClassification ?? "";
    const nextClassification = parsedClassification
      ? parsedClassification.value
      : previousClassification;
    const classificationChanged =
      parsedClassification !== null &&
      nextClassification !== previousClassification;

    // Only the two admin-owned fields are ever written. The classification is
    // set from the validated value alone — never inferred from the enquiry text
    // — so a keyword match can never overwrite an admin's choice.
    if (parsedStatus) enquiry.status = parsedStatus.value;
    if (classificationChanged) enquiry.generalClassification = nextClassification;

    if (parsedStatus || classificationChanged) {
      await enquiry.save();
    }

    if (parsedStatus) {
      await recordEnquiryAudit({
        action: "enquiry.status_changed",
        actorAdminId: auth.admin.adminId,
        reference,
        enquiryId: String(enquiry._id),
        previousStatus,
        newStatus: parsedStatus.value,
      });
    }

    if (classificationChanged) {
      await recordEnquiryAudit({
        action: "enquiry.classification_changed",
        actorAdminId: auth.admin.adminId,
        reference,
        enquiryId: String(enquiry._id),
        // Short, non-sensitive slugs (classification is organisational only).
        metadata: `${previousClassification || "unclassified"}->${nextClassification || "unclassified"}`,
      });
    }

    const message = parsedStatus
      ? "Enquiry status updated successfully."
      : "Enquiry classification updated successfully.";

    return NextResponse.json({
      success: true,
      message,
      enquiry: toSafeEnquiry(enquiry as unknown as EnquirySource),
    });
  } catch (error) {
    console.error("Admin enquiry update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update the enquiry." },
      { status: 500 }
    );
  }
}

/* ── DELETE — permanent removal of ONE enquiry ─────────────────── */

export async function DELETE(req: Request, ctx: RouteContext) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (enquiryMutationLimiter.check(req)) return rateLimited();

  const { id } = await ctx.params;
  const reference = parseEnquiryReferenceParam(id);
  if (!reference) return invalidReference();

  try {
    await connectDB();

    // Targeted lookup by reference only. The request body is never interpreted
    // as a query, so a caller cannot delete more than the one enquiry it names.
    const enquiry = (await Enquiry.findOne({
      reference,
    }).lean()) as unknown as EnquirySource | null;
    if (!enquiry) return notFound();

    const enquiryId = String(enquiry._id ?? "");

    await Enquiry.deleteOne({ reference });

    // Written AFTER the delete, and keyed on the reference: the audit trail must
    // outlive the document it describes. `enquiryId` is kept for completeness
    // but is deliberately optional in the schema, so this record stays valid
    // even though the enquiry no longer exists.
    await recordEnquiryAudit({
      action: "enquiry.deleted",
      actorAdminId: auth.admin.adminId,
      reference,
      enquiryId,
      previousStatus: enquiry.status,
    });

    return NextResponse.json({
      success: true,
      message: `Enquiry ${reference} deleted successfully.`,
    });
  } catch (error) {
    console.error("Admin enquiry delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete the enquiry." },
      { status: 500 }
    );
  }
}
