import mongoose, { Schema, type Document } from "mongoose";

/**
 * Spotlight model — admin-managed images for the public homepage
 * "Campus in the spotlight" gallery.
 *
 * Only a GridFS reference (`imageId`) is stored here; the image bytes live in
 * the shared MongoDB GridFS bucket "spotlightImages" (see lib/image-storage.ts).
 * This mirrors the syllabus PDF approach, so no binary data is kept in the
 * document and no filesystem storage is required on a serverless deploy.
 *
 * The document is deliberately minimal: image reference, accessibility text,
 * manual ordering and an active flag. The public homepage does not show a
 * caption, so no title/description fields are stored.
 */

export interface ISpotlight extends Document {
  /** GridFS ObjectId of the stored image. */
  imageId: string;
  /** Original (sanitised) filename — metadata for admins only. */
  imageName: string;
  /** Accessibility text for the public <img>. Required. */
  altText: string;
  /** Manual sort key; lower numbers appear first. */
  displayOrder: number;
  /** Inactive items are never returned by the public API. */
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const spotlightSchema = new Schema<ISpotlight>(
  {
    imageId: {
      type: String,
      required: [true, "An image is required."],
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

// The public query is "active items, ordered" — this index serves it directly.
spotlightSchema.index({ isActive: 1, displayOrder: 1 });

/** Public-safe shape (no internal fields). */
export interface SafeSpotlight {
  id: string;
  imageId: string;
  imageName: string;
  altText: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Serialise a Spotlight document for admin API responses. */
export function toSafeSpotlight(doc: ISpotlight): SafeSpotlight {
  return {
    id: doc._id.toString(),
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
const Spotlight =
  mongoose.models.Spotlight ||
  mongoose.model<ISpotlight>("Spotlight", spotlightSchema);

export default Spotlight;
