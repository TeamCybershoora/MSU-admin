import mongoose, { Schema, type Document } from "mongoose";
import { LEADERSHIP_ROLES, type LeadershipRole } from "@/lib/leadership";

/**
 * Leadership model — admin-managed university leadership records.
 *
 * Positions are FIXED (see LEADERSHIP_ROLES): the Chancellor and the Vice
 * Chancellor. `role` is the controlled key for the position; `designation` is
 * the free-text title shown to visitors. There is deliberately NO admin-managed
 * profile URL/route — any link is application-controlled.
 *
 * The API enforces at most ONE record per role, so a position always maps to a
 * single homepage card.
 *
 * Only a GridFS reference (`imageId`) is stored; the bytes live in the shared
 * `siteImages` bucket (lib/image-storage.ts).
 */

export interface ILeadership extends Document {
  /** Controlled role key (see LEADERSHIP_ROLES). */
  role: LeadershipRole;
  /** Full name, e.g. "Smt. Anandiben Patel". */
  name: string;
  /** Display title, e.g. "Hon'ble Chancellor". */
  designation: string;
  /** Optional biography / details. */
  description: string;
  /** GridFS ObjectId of the photograph. */
  imageId: string;
  /** Original (sanitised) filename — admin metadata only. */
  imageName: string;
  /** Accessibility text for the public <img>. Required. */
  altText: string;
  /** Manual sort key; lower numbers appear first. */
  displayOrder: number;
  /** Inactive records are never returned by the public API. */
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const leadershipSchema = new Schema<ILeadership>(
  {
    role: {
      type: String,
      required: [true, "Role is required."],
      enum: {
        values: [...LEADERSHIP_ROLES],
        message: "Unknown leadership role.",
      },
      index: true,
    },
    name: {
      type: String,
      required: [true, "Name is required."],
      trim: true,
      maxlength: [120, "Name must be 120 characters or fewer."],
    },
    designation: {
      type: String,
      required: [true, "Designation is required."],
      trim: true,
      maxlength: [120, "Designation must be 120 characters or fewer."],
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [2000, "Description must be 2000 characters or fewer."],
    },
    imageId: {
      type: String,
      required: [true, "A photograph is required."],
      trim: true,
    },
    imageName: {
      type: String,
      default: "",
      trim: true,
    },
    altText: {
      type: String,
      required: [true, "Alt text is required."],
      trim: true,
      maxlength: [200, "Alt text must be 200 characters or fewer."],
    },
    displayOrder: {
      type: Number,
      default: 0,
      min: [0, "Display order cannot be negative."],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// The public query is "active records, ordered".
leadershipSchema.index({ isActive: 1, displayOrder: 1 });

/** Public-safe (admin) shape. */
export interface SafeLeadership {
  id: string;
  role: LeadershipRole;
  name: string;
  designation: string;
  description: string;
  imageId: string;
  imageName: string;
  altText: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Serialise a Leadership document for admin API responses. */
export function toSafeLeadership(doc: ILeadership): SafeLeadership {
  return {
    id: doc._id.toString(),
    role: doc.role,
    name: doc.name,
    designation: doc.designation,
    description: doc.description || "",
    imageId: doc.imageId,
    imageName: doc.imageName || "",
    altText: doc.altText,
    displayOrder: doc.displayOrder,
    isActive: doc.isActive,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Leadership =
  mongoose.models.Leadership ||
  mongoose.model<ILeadership>("Leadership", leadershipSchema);

export default Leadership;
