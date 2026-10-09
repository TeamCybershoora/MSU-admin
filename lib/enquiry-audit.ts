/**
 * Enquiry audit-log writer and reader.
 *
 * Two rules drive this module:
 *
 * 1. AUDITING MUST NEVER BREAK THE ACTION. `recordEnquiryAudit()` never throws:
 *    a failure is reported to the server console (message only, no values) and
 *    the caller's flow continues.
 *
 * 2. THE TRAIL MUST SURVIVE DELETION. The audit record carries the enquiry's
 *    human reference as its durable identity, and `enquiryId` is optional — so
 *    deleting an enquiry leaves a readable history behind instead of orphaning
 *    the only identifier the audit depended on.
 *
 * Like lib/activity-log.ts this module is server-only.
 */

import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import EnquiryAuditLog, {
  type EnquiryAuditAction,
  type EnquiryAuditSource,
  toSafeEnquiryAudit,
} from "@/models/EnquiryAuditLog";

/** Newest-first history depth returned for one enquiry. */
export const ENQUIRY_AUDIT_HISTORY_LIMIT = 50;

export interface EnquiryAuditEvent {
  /** What happened (see ENQUIRY_AUDIT_ACTIONS). */
  action: EnquiryAuditAction;
  /** Admin who performed the action. */
  actorAdminId: string;
  /** Durable, human-facing identity of the enquiry. */
  reference: string;
  /** Mongo id of the enquiry, when it still exists. */
  enquiryId?: string | null;
  /** Status before the action (omit when the action has no transition). */
  previousStatus?: string;
  /** Status after the action (omit when the action has no transition). */
  newStatus?: string;
  /**
   * Short, non-sensitive result token (e.g. "smtp_accepted").
   * Never personal content and never a credential.
   */
  metadata?: string;
}

/** True when `value` is a well-formed 24-hex ObjectId string. */
function isObjectIdString(value: unknown): value is string {
  return typeof value === "string" && mongoose.Types.ObjectId.isValid(value);
}

/**
 * Record one enquiry audit event.
 *
 * Returns true when the entry was written. Never throws: auditing is secondary
 * to the operation being audited, so a failure is logged to the server console
 * (message only) and the caller continues.
 */
export async function recordEnquiryAudit(
  event: EnquiryAuditEvent
): Promise<boolean> {
  try {
    await connectDB();

    await EnquiryAuditLog.create({
      action: event.action,
      actorAdminId: event.actorAdminId,
      reference: event.reference,
      // Optional: kept as a link while the enquiry exists, and simply becomes a
      // dangling-but-harmless id once it is deleted (never a required field).
      enquiryId: isObjectIdString(event.enquiryId) ? event.enquiryId : null,
      previousStatus: event.previousStatus ?? "",
      newStatus: event.newStatus ?? "",
      metadata: event.metadata ?? "",
    });

    return true;
  } catch (error) {
    console.error(
      `Enquiry audit write failed for action "${event.action}":`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * Read one enquiry's audit history, newest first.
 *
 * Keyed on the REFERENCE rather than the ObjectId so history remains readable
 * after the enquiry itself has been deleted. The admin name is populated so the
 * UI can name the actor without ever receiving an internal id.
 *
 * Never throws: a failure returns an empty history (the enquiry itself still
 * renders).
 */
export async function getEnquiryAuditHistory(reference: string) {
  try {
    await connectDB();

    const docs = await EnquiryAuditLog.find({
      reference: reference.trim().toUpperCase(),
    })
      .sort({ createdAt: -1 })
      .limit(ENQUIRY_AUDIT_HISTORY_LIMIT)
      .populate("actorAdminId", "name")
      .lean();

    return docs.map((doc) =>
      toSafeEnquiryAudit(doc as unknown as EnquiryAuditSource)
    );
  } catch (error) {
    console.error(
      "Enquiry audit read failed:",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}
