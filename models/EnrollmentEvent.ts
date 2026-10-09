import mongoose, { Schema, type Document, type Types } from "mongoose";
import {
  ENROLLMENT_NUMBER_PATTERN,
  UNIVERSITY_ROLL_NUMBER_PATTERN,
} from "@/lib/enrollment";

/**
 * EnrollmentEvent — append-only audit record of a successful enrollment
 * (Phase 5).
 *
 * Why a separate collection: the existing ActivityLog is deliberately a closed
 * shape (action + actor/target admin ids only) and cannot hold generated
 * identifiers, and the Phase 4 `reviewHistory` array is typed to the review
 * actions/status transitions (it must never contain an "enrolled" entry — see
 * lib/student-review.ts). A dedicated event collection keeps the review history
 * intact while recording exactly what enrollment produced.
 *
 * Contents: WHO enrolled WHICH student, WHEN, and the two official identifiers
 * that were generated for that operation. It never stores credentials, tokens,
 * secrets or unrelated personal data.
 *
 * Written only by the enrollment operations (@/lib/enrollment-service), in the
 * same transaction as the Student update when the deployment supports one, so a
 * failed operation can never leave a success event behind and a repeated
 * (idempotent) request never inserts a second one. Two writers exist:
 *   action "assigned_on_verification" — issuing the identifiers as part of
 *                                       approving an application,
 *   action "enrolled"                 — assigning a missing identifier to an
 *                                       already-approved record.
 */

export const ENROLLMENT_EVENT_ACTIONS = [
  /** Identifiers assigned by the enrollment endpoint (repair path). */
  "enrolled",
  /** Identifiers assigned as part of approving an application (verify). */
  "assigned_on_verification",
] as const;
export type EnrollmentEventAction = (typeof ENROLLMENT_EVENT_ACTIONS)[number];

export interface IEnrollmentEvent extends Document {
  action: EnrollmentEventAction;
  /** The enrolled student (Student document reference). */
  studentId: Types.ObjectId;
  /** The authenticated admin who performed the enrollment. */
  actorAdminId: Types.ObjectId;
  /** The actor's server-side database role. */
  actorRole: string;
  enrollmentNumber: string;
  universityRollNumber: string;
  /** The admission year the roll number was scoped to. */
  admissionYear: number;
  /**
   * Internal correlation id for this one enrollment operation (server
   * generated). It is not an official identifier and is never used to allocate
   * anything.
   */
  operationId: string;
  /** Server-generated timestamp of the enrollment. */
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

const enrollmentEventSchema = new Schema<IEnrollmentEvent>(
  {
    action: {
      type: String,
      required: true,
      enum: ENROLLMENT_EVENT_ACTIONS,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    actorAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    actorRole: { type: String, required: true, trim: true },
    enrollmentNumber: {
      type: String,
      required: true,
      trim: true,
      match: [ENROLLMENT_NUMBER_PATTERN, "Enrollment number must be EN########."],
    },
    universityRollNumber: {
      type: String,
      required: true,
      trim: true,
      match: [
        UNIVERSITY_ROLL_NUMBER_PATTERN,
        "University roll number must be MSUYYYY######.",
      ],
    },
    admissionYear: { type: Number, required: true },
    operationId: { type: String, required: true, trim: true },
    at: { type: Date, default: Date.now, required: true },
  },
  {
    timestamps: true,
  }
);

// NOTE: no index is declared here on purpose. Mongoose's automatic index
// creation (`autoIndex`) would build it on the next app start, which is not
// authorised for this phase. The approved uniqueness indexes for the official
// identifiers are listed in ENROLLMENT_INDEX_INTENT (@/lib/enrollment) and are
// created only by the gated index script after explicit approval.

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const EnrollmentEvent =
  mongoose.models.EnrollmentEvent ||
  mongoose.model<IEnrollmentEvent>("EnrollmentEvent", enrollmentEventSchema);

export default EnrollmentEvent;
