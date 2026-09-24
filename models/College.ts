import mongoose, { Schema, type Document } from "mongoose";

/**
 * College model — stores individual affiliated colleges.
 */

export type CollegeDistrict = "Saharanpur" | "Shamli" | "Muzaffarnagar" | "";

export interface ICollege extends Document {
  collegeName: string;
  collegeCode: string;
  district: CollegeDistrict;
  createdAt: Date;
  updatedAt: Date;
}

/** Structural type for the safe mapper. */
type CollegeLike = Pick<ICollege, "collegeName" | "collegeCode" | "district">;

const collegeSchema = new Schema<ICollege>(
  {
    collegeName: {
      type: String,
      required: [true, "College name is required."],
      trim: true,
    },
    collegeCode: {
      type: String,
      default: "",
      trim: true,
    },
    district: {
      type: String,
      enum: ["Saharanpur", "Shamli", "Muzaffarnagar", ""],
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Case-insensitive unique index on collegeName to prevent duplicates
collegeSchema.index(
  { collegeName: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

/**
 * Return clean, public college data (no _id, no __v, no timestamps).
 */
export function toSafeCollege(college: CollegeLike) {
  return {
    collegeName: college.collegeName,
    collegeCode: college.collegeCode || "",
    district: college.district || "",
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const College =
  mongoose.models.College ||
  mongoose.model<ICollege>("College", collegeSchema);

export default College;
