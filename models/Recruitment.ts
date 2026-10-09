import mongoose, { Schema, type Document } from "mongoose";
import {
  RECRUITMENT_STATUSES,
  RECRUITMENT_TYPES,
  type RecruitmentRecord,
  type RecruitmentStatus,
  type RecruitmentType,
} from "@/lib/recruitment-types";

/**
 * Recruitment model — ADMIN side.
 *
 * SHARED COLLECTION: this model intentionally mirrors the public model in
 * `D:\msu\models\Recruitment.ts` field-for-field, enum-for-enum, so both apps
 * read and write the SAME MongoDB collection ("recruitments"). Mirroring
 * (rather than a separate collection) is what makes the Admin portal the
 * authoritative writer and the public site a reader of identical data.
 *
 * When changing this schema, change the public one in the same commit — a
 * mismatch would make Admin-created records unreadable by the public API.
 *
 * Document/PDF only: records reference a stored document URL served by the
 * shared GridFS PDF route. There are deliberately NO image fields.
 *
 * Visibility: the public API returns only status = "published" and
 * isDeleted = false. Ordering: displayOrder (ascending), then newest date.
 */

export interface IRecruitment extends Document {
  type: RecruitmentType;
  title: string;
  description: string;
  /** Publish date for job openings, issue date for government orders. */
  publishedDate: Date;
  /** Absolute public URL of the stored PDF (see lib/pdf-storage.ts). */
  documentUrl: string;
  /** Original document filename — used as the download filename. */
  documentName: string;
  status: RecruitmentStatus;
  displayOrder: number;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Structural shape for the admin mapper (works for hydrated and lean docs). */
type RecruitmentLike = Pick<
  IRecruitment,
  | "type"
  | "title"
  | "description"
  | "publishedDate"
  | "documentUrl"
  | "documentName"
  | "status"
  | "displayOrder"
  | "createdAt"
  | "updatedAt"
>;

const recruitmentSchema = new Schema<IRecruitment>(
  {
    type: {
      type: String,
      required: [true, "Recruitment type is required."],
      enum: {
        values: RECRUITMENT_TYPES as unknown as string[],
        message: "Type must be 'job-opening' or 'government-order'.",
      },
    },
    title: {
      type: String,
      required: [true, "Title is required."],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters."],
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [1000, "Description cannot exceed 1000 characters."],
    },
    publishedDate: {
      type: Date,
      required: [true, "Publish/issue date is required."],
    },
    documentUrl: {
      type: String,
      default: "",
      trim: true,
    },
    documentName: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: {
        values: RECRUITMENT_STATUSES as unknown as string[],
        message: "Status must be 'draft' or 'published'.",
      },
      default: "draft",
    },
    displayOrder: {
      type: Number,
      default: 0,
      min: [0, "Display order cannot be negative."],
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    suppressReservedKeysWarning: true,
  }
);

/**
 * Indexes matching the public model, so both apps query the shared collection
 * with the same access paths:
 * - status + isDeleted + type + displayOrder + publishedDate:
 *   the public read pattern.
 * - type / isDeleted: the admin filters and per-section counts.
 */
recruitmentSchema.index({
  status: 1,
  isDeleted: 1,
  type: 1,
  displayOrder: 1,
  publishedDate: -1,
});
recruitmentSchema.index({ type: 1 });
recruitmentSchema.index({ isDeleted: 1 });

/**
 * Serialise a Recruitment document for ADMIN API responses.
 * Exposes the admin record shape only — never internal Mongo fields.
 */
export function toAdminRecruitment(
  doc: RecruitmentLike & { _id?: unknown }
): RecruitmentRecord {
  return {
    id: String(doc._id ?? ""),
    type: doc.type,
    title: doc.title,
    description: doc.description || "",
    publishedDate:
      doc.publishedDate instanceof Date
        ? doc.publishedDate.toISOString()
        : String(doc.publishedDate),
    documentUrl: doc.documentUrl || "",
    documentName: doc.documentName || "",
    status: doc.status,
    displayOrder: doc.displayOrder ?? 0,
    createdAt:
      doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    updatedAt:
      doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt),
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR).
const Recruitment: mongoose.Model<IRecruitment> =
  (mongoose.models.Recruitment as mongoose.Model<IRecruitment>) ||
  mongoose.model<IRecruitment>("Recruitment", recruitmentSchema);

export default Recruitment;
