import mongoose, { Schema, type Document } from "mongoose";
import {
  type NewsStatus,
  type SafeNews,
  NEWS_IMAGE_ALT_MAX,
  NEWS_STATUSES,
  NEWS_SUMMARY_MAX,
  NEWS_TITLE_MAX,
} from "@/lib/news-types";

/**
 * News model — the dedicated university News collection.
 *
 * IMPORTANT: this is NOT the Notice collection and must never become a
 * `contentType = "news"` view of it. News has its own lifecycle, its own admin
 * page (/admin/news) and its own public API (/api/news). Notices are untouched.
 *
 * The featured image stores only a GridFS id; the bytes live in the shared
 * "siteImages" bucket (see lib/image-storage.ts), the same secure storage used
 * by Campus Spotlight and University Leadership. No binary data is stored on
 * the document and no filesystem path is ever persisted.
 *
 * The homepage shows a ROLLING WINDOW of the newest published records (see
 * /api/news). Publishing pushes the oldest item out of the window; nothing is
 * deleted. Unpublishing simply removes the record from the window.
 */

export interface INews extends Document {
  title: string;
  summary: string;
  content: string;
  /** GridFS ObjectId of the optional featured image. */
  imageId: string;
  /** Original (sanitised) featured-image filename — admin metadata only. */
  imageName: string;
  /** Accessibility text for the featured image. */
  imageAlt: string;
  publishedDate: Date;
  status: NewsStatus;
  /** Manual tie-breaker for records sharing a publication date (lower first). */
  displayOrder: number;
  /**
   * Original public path of a legacy (pre-News) homepage photo this record was
   * imported from, e.g. "/news/1784787477_8497214e7cca3599d1fa.jpeg".
   *
   * Only set by the one-off legacy import script, and uniquely indexed so a
   * re-run can never create a duplicate for the same source photo. Never
   * returned by any API.
   */
  sourceImagePath?: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type NewsLike = Pick<
  INews,
  | "title"
  | "summary"
  | "content"
  | "imageId"
  | "imageName"
  | "imageAlt"
  | "publishedDate"
  | "status"
> & { displayOrder?: number };

const newsSchema = new Schema<INews>(
  {
    title: {
      type: String,
      required: [true, "News title is required."],
      trim: true,
      maxlength: [NEWS_TITLE_MAX, `Title cannot exceed ${NEWS_TITLE_MAX} characters.`],
    },
    summary: {
      type: String,
      default: "",
      trim: true,
      maxlength: [NEWS_SUMMARY_MAX, `Summary cannot exceed ${NEWS_SUMMARY_MAX} characters.`],
    },
    content: {
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
      maxlength: [NEWS_IMAGE_ALT_MAX, `Image alt text cannot exceed ${NEWS_IMAGE_ALT_MAX} characters.`],
    },
    publishedDate: {
      type: Date,
      required: [true, "Publication date is required."],
    },
    status: {
      type: String,
      enum: {
        values: NEWS_STATUSES as unknown as string[],
        message: "Status must be 'draft' or 'published'.",
      },
      default: "draft",
    },
    displayOrder: {
      type: Number,
      default: 0,
      min: [0, "Display order cannot be negative."],
    },
    // Optional — absent on every admin-created record, so the sparse unique
    // index below only constrains imported legacy photos.
    sourceImagePath: {
      type: String,
      trim: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Serves the public query (published, non-deleted, newest first) directly.
newsSchema.index({ status: 1, isDeleted: 1, publishedDate: -1 });
newsSchema.index({ isDeleted: 1 });
// Idempotency guard for the one-off legacy photo import.
newsSchema.index({ sourceImagePath: 1 }, { unique: true, sparse: true });

/**
 * Public path that serves a stored News image by its GridFS id.
 * Images live in the shared "siteImages" bucket via lib/image-storage.ts.
 */
export function newsImageUrl(imageId: string): string {
  return imageId ? `/api/images/${imageId}` : "";
}

/** Serialise a News document for admin API responses. */
export function toSafeNews(doc: NewsLike & { _id?: unknown }): SafeNews {
  return {
    id: String(doc._id ?? ""),
    title: doc.title,
    summary: doc.summary || "",
    content: doc.content || "",
    publishedDate:
      doc.publishedDate instanceof Date
        ? doc.publishedDate.toISOString()
        : String(doc.publishedDate),
    status: doc.status,
    imageId: doc.imageId || "",
    imageName: doc.imageName || "",
    imageAlt: doc.imageAlt || "",
    imageUrl: newsImageUrl(doc.imageId || ""),
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const News = mongoose.models.News || mongoose.model<INews>("News", newsSchema);

export default News;
