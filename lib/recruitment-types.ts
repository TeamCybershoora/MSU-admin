/**
 * Recruitment contract — ADMIN side.
 *
 * This module MIRRORS the public contract in `D:\msu\lib\recruitment-types.ts`.
 * The two applications are separate codebases that share ONE MongoDB database,
 * so the stored `type` keys, `status` keys and field names here MUST stay
 * identical to the public side. Do not rename or add enum values without
 * changing the public repository in lockstep — the public page reads exactly
 * these values.
 *
 * Document/PDF only: there are deliberately NO image fields (`imageUrl`,
 * `imageId`, `thumbnail`, …) anywhere in this contract. Recruitment is a
 * document feature — it has no image upload and no gallery.
 */

/** The two kinds of record that live on the single public /recruitment page. */
export type RecruitmentType = "job-opening" | "government-order";

export const RECRUITMENT_TYPES: readonly RecruitmentType[] = [
  "job-opening",
  "government-order",
];

/** Publish/visibility status — mirrors the public side and the Notice status. */
export type RecruitmentStatus = "draft" | "published";

export const RECRUITMENT_STATUSES: readonly RecruitmentStatus[] = [
  "draft",
  "published",
];

/** Field limits — kept identical to the public model's validators. */
export const RECRUITMENT_TITLE_MAX = 200;
export const RECRUITMENT_DESCRIPTION_MAX = 1000;

/** One management section of the admin page (keyed by the shared `type`). */
export interface RecruitmentSectionMeta {
  type: RecruitmentType;
  /** Tab label / table heading — matches the public section heading. */
  label: string;
  /** Short explanation shown under the heading. */
  description: string;
  /**
   * Label for the date column. Both sections store the SAME `publishedDate`
   * field (the public contract uses one date field); only the visible label
   * differs — "Publish Date" for jobs, "Issue Date" for orders.
   */
  dateLabel: string;
  /** Label for the primary field in the create/edit form. */
  titleLabel: string;
  /** Placeholder for the primary field in the create/edit form. */
  titlePlaceholder: string;
  /** Loading/empty copy for the section. */
  emptyTitle: string;
  emptyDescription: string;
}

export const RECRUITMENT_SECTIONS: readonly RecruitmentSectionMeta[] = [
  {
    type: "job-opening",
    label: "Job Openings",
    description:
      "Recruitment notices and job openings published on the public Recruitment page.",
    dateLabel: "Publish Date",
    titleLabel: "Title",
    titlePlaceholder: "e.g. Recruitment of Assistant Professors on Contract",
    emptyTitle: "No job openings yet",
    emptyDescription:
      "Add a job opening to publish it on the public Recruitment page.",
  },
  {
    type: "government-order",
    label: "Government Orders & Circulars",
    description:
      "Government orders and circulars published on the public Recruitment page.",
    dateLabel: "Issue Date",
    titleLabel: "Title / Subject",
    titlePlaceholder:
      "e.g. Government Order regarding revised pay matrix",
    emptyTitle: "No government orders yet",
    emptyDescription:
      "Add a government order or circular to publish it on the public Recruitment page.",
  },
];

/** Admin-facing record: the public shape plus status/order/timestamps. */
export interface RecruitmentRecord {
  id: string;
  type: RecruitmentType;
  title: string;
  description: string;
  /** ISO date string. */
  publishedDate: string;
  /** Absolute public URL of the stored PDF (see lib/pdf-storage.ts). */
  documentUrl: string;
  /** Original document filename (download name). */
  documentName: string;
  status: RecruitmentStatus;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Per-section totals (published + draft) shown on the management page. */
export interface RecruitmentCounts {
  jobOpenings: number;
  governmentOrders: number;
}

/** Lookup helper for the section metadata of a record type. */
export function sectionFor(type: RecruitmentType): RecruitmentSectionMeta {
  return (
    RECRUITMENT_SECTIONS.find((section) => section.type === type) ??
    RECRUITMENT_SECTIONS[0]
  );
}
