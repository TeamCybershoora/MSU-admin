import mongoose, { Schema, type Document } from "mongoose";
import { STUDENT_STATUSES, type StudentStatus } from "@/lib/validation";
import { isEnrollmentEligible } from "@/lib/enrollment";
import {
  ACCOUNT_STATUSES,
  APPLICATION_STATUSES,
  CORRECTION_FIELDS,
  LEGACY_ACCOUNT_STATUS,
  REVIEW_ACTIONS,
  STUDENT_GENDERS,
  effectiveApplicationStatus,
  type AccountStatus,
  type ApplicationStatus,
  type CorrectionFieldEntry,
  type CorrectionRequestRecord,
  type ReviewAction,
  type ReviewHistoryRecord,
  type StudentGender,
} from "@/lib/student-review";

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

  /* ── Phase 4: shared application-review contract ─────────────────────
   * These fields already exist on documents written by the public MSU app.
   * They are declared here so the admin app reads and preserves them — no
   * migration and no bulk rewrite is performed. Legacy documents carry no
   * value and are treated as verified + active at read time. */
  gender?: StudentGender;
  fatherName?: string;
  motherName?: string;
  admissionYear?: number;

  /** Application lifecycle (no schema default — a default would mislabel
   *  legacy hydrated documents as `pending`). */
  applicationStatus?: ApplicationStatus;
  accountStatus?: AccountStatus;

  /** Review metadata. */
  rejectionReason?: string;
  /** Legacy plain-text correction note — preserved, never overwritten. */
  correctionMessage?: string;
  /** Current structured correction request. */
  correctionRequest?: CorrectionRequestRecord | null;
  /** Append-only review history; previous entries are never replaced. */
  reviewHistory?: ReviewHistoryRecord[];
  verifiedAt?: Date | null;
  verifiedBy?: string;

  /* Phase 5 official identifiers. Written ONLY by the enrollment operations
   * (@/lib/enrollment-service), from a server-allocated sequence value — never
   * from client input and never overwritten once present. Two entry points
   * issue them: approving an application (the review route's "verify" action)
   * and the enrollment endpoint (repairing a missing one). Legacy documents may
   * hold absent, empty or non-conforming values; those are reported by the
   * preflight script and a MALFORMED value is never repaired or reassigned
   * here. */
  enrolledAt?: Date | null;
  enrolledBy?: string;
  enrollmentNumber?: string | null;
  universityRollNumber?: string | null;

  registeredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/* ── Phase 4 sub-schemas (structured correction + review history) ──────── */

const correctionFieldEntrySchema = new Schema<CorrectionFieldEntry>(
  {
    field: {
      type: String,
      required: true,
      enum: [...CORRECTION_FIELDS],
    },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const correctionRequestSchema = new Schema<CorrectionRequestRecord>(
  {
    fields: { type: [correctionFieldEntrySchema], default: [] },
    additionalInstructions: { type: String, trim: true, default: "" },
    requestedAt: { type: Date },
    requestedById: { type: String, trim: true },
    requestedByRole: { type: String, trim: true },
  },
  { _id: false }
);

const reviewHistorySchema = new Schema<ReviewHistoryRecord>(
  {
    action: { type: String, required: true, enum: [...REVIEW_ACTIONS] },
    fromStatus: {
      type: String,
      required: true,
      enum: [...APPLICATION_STATUSES],
    },
    toStatus: {
      type: String,
      required: true,
      enum: [...APPLICATION_STATUSES],
    },
    reason: { type: String, trim: true, default: "" },
    fields: { type: [correctionFieldEntrySchema], default: [] },
    additionalInstructions: { type: String, trim: true, default: "" },
    actorId: { type: String, trim: true, required: true },
    actorRole: { type: String, trim: true, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

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
    /*
     * Phase 4 fields. Deliberately NO defaults on the status/review paths:
     * Mongoose applies defaults when a legacy document is hydrated from
     * MongoDB, which would mislabel existing students. Missing values are
     * normalised by toReviewStudent() at read time instead.
     */
    gender: {
      type: String,
      enum: {
        values: [...STUDENT_GENDERS],
        message: "Gender must be Male, Female or Other.",
      },
      trim: true,
    },
    fatherName: { type: String, trim: true },
    motherName: { type: String, trim: true },
    admissionYear: { type: Number },
    applicationStatus: {
      type: String,
      enum: {
        values: [...APPLICATION_STATUSES],
        message:
          "Application status must be pending, needs_correction, verified, rejected or enrolled.",
      },
    },
    accountStatus: {
      type: String,
      enum: {
        values: [...ACCOUNT_STATUSES],
        message: "Account status must be pending, active, locked or inactive.",
      },
    },
    rejectionReason: { type: String, trim: true },
    correctionMessage: { type: String, trim: true },
    correctionRequest: { type: correctionRequestSchema },
    reviewHistory: { type: [reviewHistorySchema] },
    verifiedAt: { type: Date },
    verifiedBy: { type: String, trim: true },
    /*
     * Phase 5 identifiers — no schema validators on purpose. Validators run on
     * every save, so a malformed LEGACY value would block unrelated edits
     * (student update / activate-deactivate) that the spec requires to keep
     * working. Format validation is enforced server-side by the enrollment API
     * and lib/enrollment.ts, which are the only writers of these fields.
     */
    enrolledAt: { type: Date },
    enrolledBy: { type: String, trim: true },
    enrollmentNumber: { type: String, trim: true },
    universityRollNumber: { type: String, trim: true },
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

/*
 * Phase 5 uniqueness (enrollmentNumber / universityRollNumber) is deliberately
 * NOT declared here yet. Mongoose's automatic index creation (`autoIndex`)
 * calls createIndexes as soon as the model initialises, so declaring a partial
 * unique index in the schema would create it in the live database on the next
 * app start — which is not authorised. The approved index definitions live in
 * ENROLLMENT_INDEX_INTENT (@/lib/enrollment) and are applied only by
 * `scripts/create-enrollment-indexes.ts --apply`, after the legacy-data
 * preflight shows no conflicts and explicit approval is given.
 */

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

/**
 * Safe review view used by the admin application-review API/UI.
 *
 * Exposes registration details a reviewer must check (including aadhar/abcId,
 * which the existing admin student list already exposes) but never the
 * password or any credential. Legacy documents read as verified + active, and
 * `correctionRequest`/`reviewHistory` are normalised so the UI can render them
 * without null checks. Enrollment identifiers are returned read-only for
 * display and are never mutated by this module.
 */
export function toReviewStudent(student: IStudent) {
  const correctionRequest = student.correctionRequest
    ? {
        fields: (student.correctionRequest.fields ?? []).map((entry) => ({
          field: entry.field,
          note: entry.note ?? "",
        })),
        additionalInstructions:
          student.correctionRequest.additionalInstructions ?? "",
        requestedAt: student.correctionRequest.requestedAt ?? null,
        requestedById: student.correctionRequest.requestedById ?? "",
        requestedByRole: student.correctionRequest.requestedByRole ?? "",
      }
    : null;

  const reviewHistory = (student.reviewHistory ?? []).map((entry) => ({
    action: entry.action as ReviewAction,
    fromStatus: entry.fromStatus as ApplicationStatus,
    toStatus: entry.toStatus as ApplicationStatus,
    reason: entry.reason ?? "",
    fields: (entry.fields ?? []).map((field) => ({
      field: field.field,
      note: field.note ?? "",
    })),
    additionalInstructions: entry.additionalInstructions ?? "",
    actorId: entry.actorId,
    actorRole: entry.actorRole,
    at: entry.at,
  }));

  return {
    id: student._id,
    name: student.name,
    email: student.email,
    username: student.username,
    course: student.course,
    college: student.college,
    phone: student.phone,
    aadhar: student.aadhar,
    abcId: student.abcId,
    gender: student.gender ?? null,
    fatherName: student.fatherName ?? null,
    motherName: student.motherName ?? null,
    admissionYear: student.admissionYear ?? null,
    status: student.status ?? "ACTIVE",
    // Legacy records (no stored status) read as verified + active.
    applicationStatus: effectiveApplicationStatus(student.applicationStatus),
    accountStatus: student.accountStatus ?? LEGACY_ACCOUNT_STATUS,
    rejectionReason: student.rejectionReason ?? null,
    correctionMessage: student.correctionMessage ?? null,
    correctionRequest,
    reviewHistory,
    verifiedAt: student.verifiedAt ?? null,
    enrolledAt: student.enrolledAt ?? null,
    enrollmentNumber: student.enrollmentNumber ?? null,
    universityRollNumber: student.universityRollNumber ?? null,
    /* Server-computed (never client-supplied): whether this exact record may
     * be enrolled right now. The enrollment API re-checks it independently. */
    enrollmentEligible: isEnrollmentEligible(student),
    registeredAt: student.registeredAt,
    createdAt: student.createdAt,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Student =
  mongoose.models.Student ||
  mongoose.model<IStudent>("Student", studentSchema);

export default Student;
