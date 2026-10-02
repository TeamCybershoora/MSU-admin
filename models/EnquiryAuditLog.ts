import mongoose, { Schema, type Document, type Types } from "mongoose";

/**
 * EnquiryAuditLog — append-only record of what an administrator did to an
 * enquiry.
 *
 * WHY A SEPARATE MODEL (not the existing ActivityLog):
 * `models/ActivityLog.ts` is deliberately scoped to admin CREDENTIAL events:
 * its action enum lists only the three password actions, and BOTH of its id
 * fields are required, `Admin`-typed references. An enquiry event has no admin
 * target and needs a before/after status, so reusing that schema would distort
 * its purpose and require weakening its required references.
 *
 * IDENTITY ACROSS DELETION:
 * `reference` is the DURABLE identity of the audit trail. `enquiryId` is
 * informational only and is deliberately optional, so deleting an enquiry
 * destroys neither the identity nor the history of what happened to it.
 * Audit records are never deleted when an enquiry is removed.
 *
 * PRIVACY CONTRACT (deliberate, and enforced by the schema shape):
 *   - an action name, two admin/enquiry ids, a reference, two status values,
 *     a short result token and a timestamp — nothing else
 *   - NO enquiry message, email, phone, address, or other personal content
 *   - `metadata` is a SHORT plain string (not Mixed) reserved for
 *     provider-independent result tokens such as "provider_accepted"; it exists
 *     so a free-form object can never be written here by accident
 *
 * Writes must always go through recordEnquiryAudit() in @/lib/enquiry-audit,
 * which never throws into the caller's flow.
 */

export const ENQUIRY_AUDIT_ACTIONS = [
  /** An administrator opened the enquiry's full details. */
  "enquiry.viewed",
  /** An administrator moved the enquiry to another status. */
  "enquiry.status_changed",
  /**
   * An administrator changed (or cleared) a general enquiry's optional
   * classification. The change is recorded in `metadata` as
   * `<from>-><to>` using classification slugs ("unclassified" for empty).
   */
  "enquiry.classification_changed",
  /** The email provider accepted an admin reply. */
  "enquiry.reply_sent",
  /** An admin reply could not be handed to the email provider. */
  "enquiry.reply_failed",
  /** An administrator permanently removed the enquiry. */
  "enquiry.deleted",
] as const;

export type EnquiryAuditAction = (typeof ENQUIRY_AUDIT_ACTIONS)[number];

/** Longest accepted `metadata` token. */
export const ENQUIRY_AUDIT_METADATA_MAX_LENGTH = 120;

export interface IEnquiryAuditLog extends Document {
  /**
   * The enquiry this event concerns. Optional on purpose: the document may have
   * been deleted since, and the audit trail must survive that.
   */
  enquiryId: Types.ObjectId | null;
  /** Durable, human-facing identity of the audited enquiry. */
  reference: string;
  /** The administrator who performed the action. */
  actorAdminId: Types.ObjectId;
  action: EnquiryAuditAction;
  /** Status before the action ("" when the action has no status transition). */
  previousStatus: string;
  /** Status after the action ("" when the action has no status transition). */
  newStatus: string;
  /** Short, non-sensitive result token. Never personal content, never a secret. */
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}

const enquiryAuditLogSchema = new Schema<IEnquiryAuditLog>(
  {
    enquiryId: {
      type: Schema.Types.ObjectId,
      ref: "Enquiry",
      default: null,
    },
    reference: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    actorAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    action: {
      type: String,
      required: true,
      enum: ENQUIRY_AUDIT_ACTIONS,
    },
    previousStatus: {
      type: String,
      default: "",
      trim: true,
    },
    newStatus: {
      type: String,
      default: "",
      trim: true,
    },
    metadata: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_AUDIT_METADATA_MAX_LENGTH,
        `Audit metadata must be at most ${ENQUIRY_AUDIT_METADATA_MAX_LENGTH} characters.`,
      ],
    },
  },
  {
    timestamps: true,
  }
);

/* Read patterns: one enquiry's history (newest first), and the global feed. */
enquiryAuditLogSchema.index({ reference: 1, createdAt: -1 });
enquiryAuditLogSchema.index({ createdAt: -1 });

/** Shape accepted by toSafeEnquiryAudit (hydrated, lean, or populated). */
export interface EnquiryAuditSource {
  action: EnquiryAuditAction;
  previousStatus?: string | null;
  newStatus?: string | null;
  metadata?: string | null;
  createdAt?: Date | null;
  /** ObjectId, or the populated Admin document when `.populate()` was used. */
  actorAdminId?: unknown;
}

/**
 * Resolve the acting administrator's display name from either a raw ObjectId or
 * a populated reference. Falls back to a neutral label rather than exposing an
 * internal id to the UI.
 */
function actorNameFrom(value: unknown): string {
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return "Administrator";
}

/**
 * Safe audit entry for the detail view.
 *
 * Lists every field explicitly: no `_id`, no `__v`, and no raw admin ObjectId —
 * the UI shows the actor's name or "Administrator".
 */
export function toSafeEnquiryAudit(log: EnquiryAuditSource) {
  return {
    action: log.action,
    previousStatus: log.previousStatus ?? "",
    newStatus: log.newStatus ?? "",
    metadata: log.metadata ?? "",
    actorName: actorNameFrom(log.actorAdminId),
    createdAt: log.createdAt ?? null,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const EnquiryAuditLog =
  mongoose.models.EnquiryAuditLog ||
  mongoose.model<IEnquiryAuditLog>("EnquiryAuditLog", enquiryAuditLogSchema);

export default EnquiryAuditLog;
