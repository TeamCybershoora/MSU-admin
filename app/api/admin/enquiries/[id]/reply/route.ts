import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Enquiry, { toSafeEnquiry, type EnquirySource } from "@/models/Enquiry";
import Admin from "@/models/Admin";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { recordEnquiryAudit } from "@/lib/enquiry-audit";
import { sendEnquiryReply } from "@/lib/email/provider";
import {
  canReplyFrom,
  parseEnquiryReferenceParam,
  validateReplyMessage,
} from "@/lib/enquiry-validation";

/**
 * POST /api/admin/enquiries/[id]/reply
 *
 * Send an administrator's reply to the person who submitted the enquiry.
 *
 * DESTINATION: always the enquiry's stored `email`, read from the database. The
 * request body may carry ONLY `message`; any recipient/sender/provider value a
 * caller tries to supply is ignored, so an admin can never address a reply to an
 * arbitrary third party or influence email configuration from the browser.
 *
 * SUCCESS / FAILURE SEMANTICS (important):
 *   - The enquiry becomes `responded` ONLY after the email provider accepts the
 *     message. The status is never advanced merely because a button was pressed.
 *   - On failure the enquiry is left EXACTLY as it was, a failure entry is
 *     recorded in the audit trail, and the administrator receives a safe generic
 *     message so the reply can be retried. Provider detail and secrets are never
 *     returned to the client.
 *   - "Accepted by the provider" is the boundary this application can verify.
 *     Neither the response nor the audit log claims delivery to the final inbox.
 *
 * Authentication: any active admin (authenticateAdmin).
 * Rate limited: 10 replies / 15 min per client — sending mail is expensive.
 * Every outcome is audited: enquiry.reply_sent or enquiry.reply_failed.
 */

const replyLimiter = createRateLimiter({
  name: "admin-enquiry-reply",
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (replyLimiter.check(req)) {
    return NextResponse.json(
      {
        success: false,
        message: "Too many replies sent. Please wait a few minutes and try again.",
      },
      { status: 429 }
    );
  }

  const { id } = await ctx.params;
  const reference = parseEnquiryReferenceParam(id);
  if (!reference) {
    return NextResponse.json(
      { success: false, message: "Invalid enquiry reference." },
      { status: 400 }
    );
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { success: false, message: "Invalid request body." },
        { status: 400 }
      );
    }

    // Only the reply text is read. `to`, `from`, `subject` and any provider
    // setting are deliberately never consulted.
    const parsedMessage = validateReplyMessage(
      (body as Record<string, unknown>).message
    );
    if (!parsedMessage.ok) {
      return NextResponse.json(
        { success: false, message: parsedMessage.message },
        { status: 400 }
      );
    }

    await connectDB();

    const enquiry = await Enquiry.findOne({ reference });
    if (!enquiry) {
      return NextResponse.json(
        { success: false, message: "Enquiry not found." },
        { status: 404 }
      );
    }

    if (!canReplyFrom(enquiry.status)) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This enquiry is closed. Reopen it before sending a reply.",
        },
        { status: 400 }
      );
    }

    // Signature name for the email — the acting administrator's own record.
    const actor = await Admin.findById(auth.admin.adminId)
      .select("name")
      .lean() as unknown as { name?: string } | null;
    const adminName = actor?.name?.trim() || "MSU Administration";

    const repliedAt = new Date();

    const delivery = await sendEnquiryReply({
      // Authoritative destination: the submitter's stored address.
      to: enquiry.email,
      reference,
      type: enquiry.type,
      adminName,
      message: parsedMessage.value,
      repliedAt,
    });

    const previousStatus = enquiry.status;

    if (!delivery.sent) {
      // The enquiry is deliberately untouched: no status change, no data loss,
      // and the administrator can retry. Only a safe reason token is audited.
      await recordEnquiryAudit({
        action: "enquiry.reply_failed",
        actorAdminId: auth.admin.adminId,
        reference,
        enquiryId: String(enquiry._id),
        previousStatus,
        newStatus: previousStatus,
        metadata: delivery.reason,
      });

      return NextResponse.json(
        {
          success: false,
          message: "Unable to send reply. Please try again.",
        },
        { status: 502 }
      );
    }

    // Provider accepted the message — only now does the enquiry become
    // "responded". Re-replying to an already-responded enquiry keeps the status
    // and simply records another reply event.
    if (previousStatus !== "responded") {
      enquiry.status = "responded";
      await enquiry.save();
    }

    await recordEnquiryAudit({
      action: "enquiry.reply_sent",
      actorAdminId: auth.admin.adminId,
      reference,
      enquiryId: String(enquiry._id),
      previousStatus,
      newStatus: enquiry.status,
      metadata: delivery.reason,
    });

    return NextResponse.json({
      success: true,
      message: "Reply sent successfully.",
      enquiry: toSafeEnquiry(enquiry as unknown as EnquirySource),
    });
  } catch (error) {
    console.error("Admin enquiry reply error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to send reply. Please try again." },
      { status: 500 }
    );
  }
}
