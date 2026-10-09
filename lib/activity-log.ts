/**
 * Activity log writer for admin security events.
 *
 * The event shape is deliberately closed: an action name and two admin ids.
 * There is no parameter (and no model field) that could carry a password, a
 * hash, a ciphertext or the encryption key, so credentials cannot leak into the
 * audit trail by accident.
 *
 * Like lib/password.ts, this module is server-only.
 */

import connectDB from "@/lib/mongodb";
import ActivityLog, { type ActivityAction } from "@/models/ActivityLog";

export interface AdminActivityEvent {
  /** What happened (see ACTIVITY_ACTIONS). */
  action: ActivityAction;
  /** Admin who performed the action. */
  actorAdminId: string;
  /** Admin account the action applied to. */
  targetAdminId: string;
}

/**
 * Record an event. Returns true when the entry was written.
 *
 * Never throws: auditing is secondary to the operation being audited, so a
 * failure is reported to the server console (message only, no values) and the
 * caller's flow continues.
 */
export async function recordAdminActivity(event: AdminActivityEvent): Promise<boolean> {
  try {
    await connectDB();
    await ActivityLog.create({
      action: event.action,
      actorAdminId: event.actorAdminId,
      targetAdminId: event.targetAdminId,
    });
    return true;
  } catch (error) {
    console.error(`Activity log write failed for action "${event.action}":`, error);
    return false;
  }
}
