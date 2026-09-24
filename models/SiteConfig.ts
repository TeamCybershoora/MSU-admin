import mongoose, { Schema, type Document } from "mongoose";

/**
 * SiteConfig model — stores site-wide configuration as key-value pairs.
 */

export interface ISiteConfig extends Document {
  configKey: string;
  configValue: string;
  updatedAt: Date;
  createdAt: Date;
}

const siteConfigSchema = new Schema<ISiteConfig>(
  {
    configKey: {
      type: String,
      required: [true, "Config key is required."],
      trim: true,
      lowercase: true,
    },
    configValue: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

siteConfigSchema.index({ configKey: 1 }, { unique: true });

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const SiteConfig =
  mongoose.models.SiteConfig ||
  mongoose.model<ISiteConfig>("SiteConfig", siteConfigSchema);

export default SiteConfig;
