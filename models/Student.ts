import mongoose, { Schema, type Document } from "mongoose";
import { STUDENT_STATUSES, type StudentStatus } from "@/lib/validation";

/**
 * Student model — one document per registered student account.
 *
 * `status` is the account lifecycle state:
 * - "ACTIVE"   — a normal student (the default).
 * - "INACTIVE" — deactivated: the student stays in MongoDB and every stored
 *                 field is unchanged, but the account is treated as not
 *                 active. Deactivation is NOT deletion.
 *
 * Documents created before the field existed carry no stored status and are
 * treated as ACTIVE both in queries and in toSafeStudent(). They are never
 * migrated or rewritten in bulk.
 */
export type { StudentStatus };

export interface IStudent extends Document {
  name: string;
  email: string;
  username: string;
  password: string;
  course: string;
  aadhar: string;
  abcId: string;
  phone: string;
  college: string;
  profileImage: string;
  /** Account state; defaults to ACTIVE. Legacy docs without it are ACTIVE. */
  status: StudentStatus;
  registeredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const studentSchema = new Schema<IStudent>(
  {
    name: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      validate: {
        validator: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: "Please enter a valid email address.",
      },
    },
    username: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    course: {
      type: String,
      required: [true, "Course is required"],
      trim: true,
    },
    aadhar: {
      type: String,
      required: [true, "Aadhar number is required"],
      unique: true,
      trim: true,
      validate: {
        validator: (v: string) => /^\d{12}$/.test(v.replace(/-/g, "")),
        message: "Aadhar must be exactly 12 digits.",
      },
    },
    abcId: {
      type: String,
      required: [true, "ABC ID is required"],
      unique: true,
      trim: true,
      validate: {
        validator: (v: string) => /^[A-Za-z0-9]{12}$/.test(v),
        message: "ABC ID must be exactly 12 alphanumeric characters.",
      },
    },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
      validate: {
        validator: (v: string) => /^\d{10}$/.test(v),
        message: "Phone number must be exactly 10 digits.",
      },
    },
    college: {
      type: String,
      required: [true, "College name is required"],
      trim: true,
    },
    profileImage: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: {
        values: [...STUDENT_STATUSES],
        message: "Status must be one of: ACTIVE, INACTIVE.",
      },
      default: "ACTIVE",
    },
    registeredAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Case-insensitive unique index on email
studentSchema.index(
  { email: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

/**
 * Return safe student data (no password, no sensitive fields).
 */
export function toSafeStudent(student: IStudent) {
  return {
    id: student._id,
    name: student.name,
    email: student.email,
    course: student.course,
    college: student.college,
    phone: student.phone,
    aadhar: student.aadhar,
    abcId: student.abcId,
    profileImage: student.profileImage,
    // Legacy documents (no stored status) are reported as ACTIVE.
    status: student.status ?? "ACTIVE",
    registeredAt: student.registeredAt,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Student =
  mongoose.models.Student ||
  mongoose.model<IStudent>("Student", studentSchema);

export default Student;
