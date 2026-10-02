import mongoose, { Schema, type Document } from "mongoose";
import {
  type NoticeCategory,
  type NoticeStatus,
  type ContentType,
  type SafeNotice,
  VALID_CATEGORIES,
  VALID_STATUSES,
  VALID_CONTENT_TYPES,
} from "@/lib/notice-types";

/**
 * Notice model — stores university notices and announcements.
 */

export interface INotice extends Document {
  title: string;
  summary: string;
  content: string;
  category: NoticeCategory;
  contentType: ContentType;
  publishedDate: Date;
  isNewNotice: boolean;
  isImportant: boolean;
  status: NoticeStatus;
  attachmentName: string;
  attachmentUrl: string;
  /** GridFS ObjectId of the optional featured image (news cards). */
  imageId: string;
  /** Original (sanitised) featured-image filename — admin metadata only. */
  imageName: string;
  /** Accessibility text for the featured image. */
  imageAlt: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type NoticeLike = Pick<
  INotice,
  | "title"
  | "summary"
  | "content"
  | "category"
  | "contentType"
  | "publishedDate"
  | "isNewNotice"
  | "isImportant"
  | "status"
  | "attachmentName"
  | "attachmentUrl"
  | "imageId"
  | "imageName"
  | "imageAlt"
>;

const noticeSchema = new Schema<INotice>(
  {
    title: {
      type: String,
      required: [true, "Notice title is required."],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters."],
    },
    summary: {
      type: String,
      required: [true, "Notice summary is required."],
      trim: true,
      maxlength: [500, "Summary cannot exceed 500 characters."],
    },
    content: {
      type: String,
      required: [true, "Notice content is required."],
      trim: true,
    },
    category: {
      type: String,
      required: [true, "Notice category is required."],
      enum: {
        values: VALID_CATEGORIES as unknown as string[],
        message: "Category must be one of: {VALUES}",
      },
    },
    contentType: {
      type: String,
      enum: {
        values: VALID_CONTENT_TYPES as unknown as string[],
        message: "Content type must be 'notice', 'circular', or 'news'.",
      },
      default: "notice",
    },
    publishedDate: {
      type: Date,
      required: [true, "Published date is required."],
    },
    isNewNotice: {
      type: Boolean,
      default: false,
    },
    isImportant: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: {
        values: VALID_STATUSES as unknown as string[],
        message: "Status must be 'draft' or 'published'.",
      },
      default: "draft",
    },
    attachmentName: {
      type: String,
      default: "",
      trim: true,
    },
    attachmentUrl: {
      type: String,
      default: "",
      trim: true,
    },
    imageId: {
      type: String,
      default: "",
      trim: true,
    },
    imageName: {
      type: String,
      default: "",
      trim: true,
    },
    imageAlt: {
      type: String,
      default: "",
      trim: true,
      maxlength: [200, "Image alt text cannot exceed 200 characters."],
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

noticeSchema.index({ status: 1, isDeleted: 1, publishedDate: -1 });
noticeSchema.index({ contentType: 1, status: 1, isDeleted: 1 });
noticeSchema.index({ category: 1 });
noticeSchema.index({ isDeleted: 1 });

/**
 * Public path that serves a stored notice image by its GridFS id.
 * Images are stored in the shared "siteImages" bucket via lib/image-storage.ts
 * (the same storage used by Campus Spotlight and University Leadership).
 */
export function noticeImageUrl(imageId: string): string {
  return imageId ? `/api/images/${imageId}` : "";
}

/**
 * Return clean, public-safe notice data.
 */
export function toSafeNotice(doc: NoticeLike & { _id?: unknown }): SafeNotice {
  return {
    id: String(doc._id ?? ""),
    title: doc.title,
    summary: doc.summary,
    content: doc.content,
    category: doc.category,
    contentType: doc.contentType || "notice",
    publishedDate: doc.publishedDate instanceof Date ? doc.publishedDate.toISOString() : String(doc.publishedDate),
    isNew: doc.isNewNotice,
    isImportant: doc.isImportant,
    status: doc.status,
    attachmentName: doc.attachmentName || "",
    attachmentUrl: doc.attachmentUrl || "",
    imageUrl: noticeImageUrl(doc.imageId || ""),
    imageAlt: doc.imageAlt || "",
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Notice =
  mongoose.models.Notice || mongoose.model<INotice>("Notice", noticeSchema);

export default Notice;
