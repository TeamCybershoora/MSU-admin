/**
 * Shared Notice types and constants.
 *
 * This is the SINGLE source of truth for notice categories and content types.
 * Do NOT duplicate the category list elsewhere.
 */

export type NoticeCategory =
  | "Examination"
  | "Admission"
  | "Academic"
  | "General"
  | "Recruitment"
  | "Student"
  | "Other";

export const NOTICE_CATEGORIES: NoticeCategory[] = [
  "Examination",
  "Admission",
  "Academic",
  "General",
  "Recruitment",
  "Student",
  "Other",
];

/** All valid category values for use in validation. */
export const VALID_CATEGORIES: readonly string[] = NOTICE_CATEGORIES;

/** Content type — distinguishes notices, circulars, and news. */
export type ContentType = "notice" | "circular" | "news";

export const VALID_CONTENT_TYPES: readonly ContentType[] = ["notice", "circular", "news"];

/** Notice status values. */
export type NoticeStatus = "draft" | "published";

export const VALID_STATUSES: readonly NoticeStatus[] = ["draft", "published"];

/**
 * Public-safe notice shape returned by APIs.
 * Does NOT expose _id, __v, isDeleted, or other internal fields.
 */
export interface SafeNotice {
  id: string;
  title: string;
  summary: string;
  content: string;
  category: NoticeCategory;
  contentType: ContentType;
  /** ISO date string — JSON serialization converts Date to string. */
  publishedDate: string;
  /** Whether this notice is marked as "new" (shown with a badge in UI). */
  isNew: boolean;
  isImportant: boolean;
  status: NoticeStatus;
  attachmentName: string;
  attachmentUrl: string;
  /** Public URL of the featured image, or "" when none is set. */
  imageUrl: string;
  /** Accessibility text for the featured image. */
  imageAlt: string;
}
