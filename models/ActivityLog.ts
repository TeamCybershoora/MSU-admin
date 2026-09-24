import mongoose, { Schema, type Document, type Types } from "mongoose";

/**
 * ActivityLog — append-only record of admin security events.
 *
 * Deliberately minimal and event-only: it stores WHO did WHAT to WHOM and WHEN,
 * never the material involved.
 *
 * There is intentionally NO free-form `message`, `details` or `metadata` field,
 * so a password (plaintext, ciphertext or hash) structurally cannot be written
 * here — every stored value is an id, an action name or a timestamp.
 *
 * Event timestamps come from `createdAt` (Schema `timestamps: true`).
 *
 * Writes must always go through recordAdminActivity() in @/lib/activity-log,
 * which never throws into the caller's flow.
 */

export type ActivityAction =
  /** A normal admin replaced their own password. */
  | "admin.password.changed"
  /** A Super Admin reset a normal admin's password. */
  | "admin.password.reset"
  /** A Super Admin recovered a normal admin's current password. */
  | "admin.password.viewed";

export const ACTIVITY_ACTIONS: ActivityAction[] = [
  "admin.password.changed",
  "admin.password.reset",
  "admin.password.viewed",
];

export interface IActivityLog extends Document {
  action: ActivityAction;
  /** The admin who performed the action. */
  actorAdminId: Types.ObjectId;
  /** The admin account the action applied to. */
  targetAdminId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    action: {
      type: String,
      required: true,
      enum: ACTIVITY_ACTIONS,
      index: true,
    },
    actorAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
      index: true,
    },
    targetAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Admin security events are read newest-first.
activityLogSchema.index({ createdAt: -1 });

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const ActivityLog =
  mongoose.models.ActivityLog ||
  mongoose.model<IActivityLog>("ActivityLog", activityLogSchema);

export default ActivityLog;
