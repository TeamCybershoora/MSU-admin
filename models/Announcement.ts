import mongoose, { Schema, type Document } from "mongoose";

/**
 * Announcement model — admin-managed entries for the site-wide
 * <AnnouncementBar /> on the public MSU website.
 *
 * The Admin portal is the AUTHORITATIVE WRITER; the public site only reads the
 * shared `announcements` collection. Content is distinct from Notices, so this
 * is a dedicated model rather than a SiteConfig key or a Notice view.
 *
 * Scheduling:
 * - `isEnabled` is the admin on/off switch.
 * - `startAt` / `endAt` are OPTIONAL. They are stored as UTC instants; the admin
 *   UI edits them in IST (Asia/Kolkata). `null` means "no bound".
 *   Eligibility (enforced by the public API, using server time) is:
 *     isEnabled && (startAt == null || now >= startAt) && (endAt == null || now <= endAt)
 *
 * The four content fields mirror the public component's `Announcement` shape
 * exactly (`eyebrow`, `headline`, `sub`, `href`) so the public bar can consume
 * records without any markup change. The CTA label ("View details") and the
 * icons/decorative elements are built into the public component and are NOT
 * configurable here.
 */

export interface IAnnouncement extends Document {
  /** Small category/session label above the headline. */
  eyebrow: string;
  /** Primary announcement text. Required. */
  headline: string;
  /** Supporting description. Optional. */
  sub: string;
  /** Destination of the existing "View details" CTA (internal path or https URL). */
  href: string;
  /** Admin-controlled enable/disable switch. */
  isEnabled: boolean;
  /** Optional scheduled start (UTC). `null` = no lower bound. */
  startAt: Date | null;
  /** Optional scheduled end (UTC). `null` = no upper bound. */
  endAt: Date | null;
  /** Manual sort key; lower numbers rotate first. */
  displayOrder: number;
  /** Admin id that created the record (audit). */
  createdBy: string;
  /** Admin id of the last update (audit). */
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const announcementSchema = new Schema<IAnnouncement>(
  {
    eyebrow: {
      type: String,
      default: "",
      trim: true,
      maxlength: [120, "Eyebrow cannot exceed 120 characters."],
    },
    headline: {
      type: String,
      required: [true, "Headline is required."],
      trim: true,
      maxlength: [200, "Headline cannot exceed 200 characters."],
    },
    sub: {
      type: String,
      default: "",
      trim: true,
      maxlength: [300, "Supporting text cannot exceed 300 characters."],
    },
    href: {
      type: String,
      required: [true, "Destination link is required."],
      trim: true,
      maxlength: [500, "Destination link cannot exceed 500 characters."],
    },
    isEnabled: {
      type: Boolean,
      default: true,
    },
    startAt: {
      type: Date,
      default: null,
    },
    endAt: {
      type: Date,
      default: null,
    },
    displayOrder: {
      type: Number,
      default: 0,
      min: [0, "Display order cannot be negative."],
    },
    createdBy: {
      type: String,
      default: "",
      trim: true,
    },
    updatedBy: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// The public query is "enabled, ordered" — this index serves it directly.
announcementSchema.index({ isEnabled: 1, displayOrder: 1 });
announcementSchema.index({ displayOrder: 1, createdAt: 1 });

/** Public/admin-safe shape (no internal fields). */
export interface SafeAnnouncement {
  id: string;
  eyebrow: string;
  headline: string;
  sub: string;
  href: string;
  isEnabled: boolean;
  startAt: string | null;
  endAt: string | null;
  displayOrder: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Serialise an Announcement document for the admin API. */
export function toSafeAnnouncement(doc: IAnnouncement): SafeAnnouncement {
  return {
    id: doc._id.toString(),
    eyebrow: doc.eyebrow || "",
    headline: doc.headline,
    sub: doc.sub || "",
    href: doc.href,
    isEnabled: doc.isEnabled,
    startAt: iso(doc.startAt),
    endAt: iso(doc.endAt),
    displayOrder: doc.displayOrder,
    createdBy: doc.createdBy || "",
    updatedBy: doc.updatedBy || "",
    createdAt: iso(doc.createdAt) ?? "",
    updatedAt: iso(doc.updatedAt) ?? "",
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Announcement =
  mongoose.models.Announcement ||
  mongoose.model<IAnnouncement>("Announcement", announcementSchema);

export default Announcement;
