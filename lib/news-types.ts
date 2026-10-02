/**
 * Shared News types and constants.
 *
 * News is a FIRST-CLASS content system, deliberately separate from Notices.
 * It has its own collection (models/News.ts), its own admin APIs
 * (/api/admin/news) and its own public API (/api/news). It must never be
 * modelled as a filtered subset of Notice (i.e. contentType = "news").
 *
 * This is the SINGLE source of truth for news statuses and the public-safe
 * shape. Do NOT reuse Notice's category list here — News has no categories.
 */

/** Publication state. Only "published" records are eligible for the homepage. */
export type NewsStatus = "draft" | "published";

export const NEWS_STATUSES: readonly NewsStatus[] = ["draft", "published"];

/** Maximum length of a News image's alt text. */
export const NEWS_IMAGE_ALT_MAX = 200;

/** Maximum length of a News title. */
export const NEWS_TITLE_MAX = 200;

/** Maximum length of a News summary/heading. */
export const NEWS_SUMMARY_MAX = 500;

/**
 * Admin-safe News shape returned by /api/admin/news.
 *
 * `imageId`/`imageName` are included (unlike the public shape) so the edit form
 * can show the current image and preserve or replace it without losing it.
 */
export interface SafeNews {
  id: string;
  title: string;
  summary: string;
  content: string;
  /** ISO date string — JSON serialization converts Date to string. */
  publishedDate: string;
  status: NewsStatus;
  /** GridFS id of the featured image, or "" when none is set. */
  imageId: string;
  /** Sanitised original filename — admin metadata only. */
  imageName: string;
  /** Accessibility text for the featured image. */
  imageAlt: string;
  /** Public URL of the featured image, or "" when none is set. */
  imageUrl: string;
}

/**
 * Public-safe News shape returned by /api/news.
 * Deliberately omits status, imageId, imageName, displayOrder, isDeleted and
 * timestamps — the homepage only needs presentable fields.
 */
export interface PublicNews {
  id: string;
  title: string;
  summary: string;
  content: string;
  publishedDate: string;
  imageUrl: string;
  imageAlt: string;
}
