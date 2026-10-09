import mongoose, { Schema, type Document } from "mongoose";
import {
  COLLEGE_TYPES,
  DISTRICTS,
  ENQUIRY_FIELD_LIMITS,
  ENQUIRY_STATUSES,
  ENQUIRY_TYPES,
  GENERAL_INQUIRY_TYPES,
  INQUIRY_TYPE_ALIASES,
  MESSAGE_MIN_LENGTH,
  isEnquiryReference,
  isValidContactNumber,
  normalizeInquiryType,
  type EnquiryStatus,
  type EnquiryType,
} from "@/lib/enquiry-types";
import { GENERAL_CLASSIFICATIONS } from "@/lib/enquiry-categories";
import { isValidEmail } from "@/lib/validation";

/**
 * Enquiry model — represents the documents the PUBLIC MSU project writes to the
 * shared `enquiries` collection.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ THIS SCHEMA MIRRORS THE PUBLIC MSU ENQUIRY SCHEMA. DO NOT RE-INTERPRET.│
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * The public Contact page is the only creator of enquiries; this application
 * reads them and manages `status` plus the optional admin-only
 * `generalClassification`. Everything else (field names, types, enums, casing
 * rules and the empty-string convention) is copied verbatim so both
 * applications see exactly the same documents.
 *
 * Compatibility rules that must not drift:
 *   - the stored status is `in_review` — never `review`
 *   - type-specific fields that do not apply are `""`, never null and never
 *     missing: every field declares `default: ""`, so a value is always stored
 *   - `email` is lowercased, `phone` is normalised to 10 digits, `reference`
 *     is uppercased
 *   - `reference` is unique AND sparse, so legacy documents without one remain
 *     valid
 *   - `status` defaults to `new`; the public API never accepts it from a client
 *
 * Fields deliberately NOT added to this shared schema (they would change the
 * public contract): acknowledgementSent, notificationSent, emailSent,
 * respondedAt, closedAt, adminNote, isDeleted, deletedAt. Reply and status
 * history lives in `models/EnquiryAuditLog.ts` instead.
 *
 * `status` and the OPTIONAL `generalClassification` are the only fields this
 * application ever writes. The classification is additive and admin-owned: the
 * public application neither sets nor reads it, and existing documents that
 * lack it are read as unclassified ("").
 */

export interface IEnquiry extends Document {
  type: EnquiryType;
  status: EnquiryStatus;

  /** Safe, human-readable public reference, e.g. MSU-ENQ-48J7PRKQ. */
  reference: string;

  /* ── Fields shared by every enquiry type ── */
  email: string;
  phone: string;
  message: string;

  /* ── Admission enquiry ── */
  fullName: string;
  course: string;
  session: string;

  /**
   * Topic chosen by the PUBLIC submitter on the General Enquiry form.
   * "" means unspecified — a record that predates the field. This application
   * never writes it. See @/lib/enquiry-types.
   */
  inquiryType: string;

  /**
   * Optional ADMIN classification, used only for general (Contact Us)
   * enquiries and never derived from keyword matching. Empty string means
   * "Unclassified". See @/lib/enquiry-categories.
   */
  generalClassification: string;

  /* ── College registration / affiliation enquiry ── */
  collegeName: string;
  contactPerson: string;
  designation: string;
  address: string;
  district: string;
  collegeType: string;
  purpose: string;
  courses: string;

  createdAt: Date;
  updatedAt: Date;
}

/** Marks a type-specific field as required only for that enquiry type. */
function requiredForType(type: EnquiryType) {
  return function (this: IEnquiry) {
    return this.type === type;
  };
}

const enquirySchema = new Schema<IEnquiry>(
  {
    type: {
      type: String,
      required: [true, "Enquiry type is required."],
      enum: {
        values: [...ENQUIRY_TYPES],
        message: "Invalid enquiry type.",
      },
    },
    status: {
      type: String,
      enum: {
        values: [...ENQUIRY_STATUSES],
        message: "Invalid enquiry status.",
      },
      default: "new",
    },

    /* ── Public reference number ── */
    reference: {
      type: String,
      required: [true, "Enquiry reference is required."],
      trim: true,
      uppercase: true,
      // Unique across the collection; `sparse` keeps legacy pre-reference
      // documents valid (they simply have no reference).
      unique: true,
      sparse: true,
      validate: {
        validator: (v: string) => isEnquiryReference(v),
        message: "Invalid enquiry reference format.",
      },
    },

    /* ── Fields shared by every enquiry type ── */
    email: {
      type: String,
      required: [true, "Email address is required."],
      lowercase: true,
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.email,
        `Email address must be at most ${ENQUIRY_FIELD_LIMITS.email} characters.`,
      ],
      validate: {
        validator: (v: string) => isValidEmail(v),
        message: "Please enter a valid email address.",
      },
    },
    phone: {
      type: String,
      required: [true, "Contact number is required."],
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.phone,
        `Contact number must be at most ${ENQUIRY_FIELD_LIMITS.phone} characters.`,
      ],
      validate: {
        validator: (v: string) => isValidContactNumber(v),
        message: "Contact number must be a valid 10-digit number.",
      },
    },
    message: {
      type: String,
      required: [true, "Query / message is required."],
      trim: true,
      minlength: [
        MESSAGE_MIN_LENGTH,
        `Query / message must be at least ${MESSAGE_MIN_LENGTH} characters.`,
      ],
      maxlength: [
        ENQUIRY_FIELD_LIMITS.message,
        `Query / message must be at most ${ENQUIRY_FIELD_LIMITS.message} characters.`,
      ],
    },

    /* ── Admission enquiry ── */
    fullName: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.fullName,
        `Full name must be at most ${ENQUIRY_FIELD_LIMITS.fullName} characters.`,
      ],
      required: [
        requiredForType("admission"),
        "Full name is required for admission enquiries.",
      ],
    },
    course: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.course,
        `Course / programme must be at most ${ENQUIRY_FIELD_LIMITS.course} characters.`,
      ],
    },
    session: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.session,
        `Admission session must be at most ${ENQUIRY_FIELD_LIMITS.session} characters.`,
      ],
    },

    /* ── General (Contact Us) enquiry — topic chosen by the public user ── */
    // OWNED BY THE PUBLIC APPLICATION: this app only ever READS it, so there
    // is deliberately NO `default` — stamping one on would risk writing a
    // value onto a legacy document the next time an admin saves a status or a
    // classification, and no existing record may be rewritten. A missing
    // value is read as "" ("Unspecified") by the response mappers.
    // The enum accepts the canonical slugs PLUS the aliases the public system
    // has used, so a document written with either spelling stays valid.
    inquiryType: {
      type: String,
      trim: true,
      enum: {
        values: [
          ...GENERAL_INQUIRY_TYPES,
          ...Object.keys(INQUIRY_TYPE_ALIASES),
          "",
        ],
        message: "Invalid inquiry type.",
      },
    },

    /* ── General (Contact Us) enquiry — optional admin classification ── */
    generalClassification: {
      type: String,
      default: "",
      trim: true,
      enum: {
        values: [...GENERAL_CLASSIFICATIONS, ""],
        message: "Invalid general enquiry classification.",
      },
    },

    /* ── College registration / affiliation enquiry ── */
    collegeName: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.collegeName,
        `College / institution name must be at most ${ENQUIRY_FIELD_LIMITS.collegeName} characters.`,
      ],
      required: [
        requiredForType("affiliation"),
        "College / institution name is required for affiliation enquiries.",
      ],
    },
    contactPerson: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.contactPerson,
        `Contact person name must be at most ${ENQUIRY_FIELD_LIMITS.contactPerson} characters.`,
      ],
      required: [
        requiredForType("affiliation"),
        "Contact person name is required for affiliation enquiries.",
      ],
    },
    designation: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.designation,
        `Designation / role must be at most ${ENQUIRY_FIELD_LIMITS.designation} characters.`,
      ],
    },
    address: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.address,
        `College address must be at most ${ENQUIRY_FIELD_LIMITS.address} characters.`,
      ],
      required: [
        requiredForType("affiliation"),
        "College address is required for affiliation enquiries.",
      ],
    },
    district: {
      type: String,
      default: "",
      trim: true,
      enum: {
        values: [...DISTRICTS, ""],
        message: "Invalid district.",
      },
      required: [
        requiredForType("affiliation"),
        "District is required for affiliation enquiries.",
      ],
    },
    collegeType: {
      type: String,
      default: "",
      trim: true,
      enum: {
        values: [...COLLEGE_TYPES, ""],
        message: "Invalid college type.",
      },
    },
    purpose: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.purpose,
        `Registration / affiliation purpose must be at most ${ENQUIRY_FIELD_LIMITS.purpose} characters.`,
      ],
      required: [
        requiredForType("affiliation"),
        "Registration / affiliation purpose is required for affiliation enquiries.",
      ],
    },
    courses: {
      type: String,
      default: "",
      trim: true,
      maxlength: [
        ENQUIRY_FIELD_LIMITS.courses,
        `Courses / programmes offered must be at most ${ENQUIRY_FIELD_LIMITS.courses} characters.`,
      ],
    },
  },
  {
    timestamps: true,
    // The collection is owned by the public MSU application. It resolves to the
    // same name by Mongoose inference there (model "Enquiry" → "enquiries"), so
    // the name is declared explicitly here to guarantee both applications read
    // and write ONE collection rather than silently diverging.
    collection: "enquiries",
  }
);

/*
 * Indexes: identical specifications to the public schema, declared so the two
 * models agree. Creating an index that already exists with the same keys and
 * the same options is a no-op, and no index is added that the public model
 * does not already define — the Admin app must never change how the public
 * collection is indexed.
 *
 *   reference                      → unique + sparse (from the field options)
 *   type + status + createdAt DESC → the public list/filter access pattern
 */
enquirySchema.index({ type: 1, status: 1, createdAt: -1 });

/* ── Response mappers ──────────────────────────────────────────── */

/** Shape accepted by toSafeEnquiry / toEnquirySummary (hydrated or lean). */
export interface EnquirySource {
  _id?: unknown;
  type: EnquiryType;
  status: EnquiryStatus;
  reference: string;
  email: string;
  phone: string;
  message: string;
  fullName: string;
  course: string;
  session: string;
  collegeName: string;
  contactPerson: string;
  designation: string;
  address: string;
  district: string;
  collegeType: string;
  purpose: string;
  courses: string;
  /** Optional admin classification (general enquiries only; "" = unclassified). */
  generalClassification?: string | null;
  /** Topic chosen by the public user (general enquiries; "" = unspecified). */
  inquiryType?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

/**
 * Mask an email address so a list can identify the submitter without printing
 * their full address: `jane.doe@example.com` → `j•••••••@example.com`.
 */
function maskEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim() : "";
  const at = email.lastIndexOf("@");
  if (at <= 0) return email ? "•••" : "";

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const bullets = "•".repeat(Math.min(Math.max(local.length - 1, 1), 6));

  return `${local.charAt(0)}${bullets}@${domain}`;
}

/**
 * List row for the enquiries table.
 *
 * MINIMISES PII: the full email, the phone number, the address and the whole
 * message are deliberately absent — they are only returned by toSafeEnquiry()
 * once an administrator opens a single enquiry.
 */
export function toEnquirySummary(enquiry: EnquirySource) {
  const isAffiliation = enquiry.type === "affiliation";

  return {
    /** Human-facing identity — the ObjectId is never exposed. */
    reference: enquiry.reference,
    type: enquiry.type,
    status: enquiry.status,
    createdAt: enquiry.createdAt ?? null,
    /** Only the information needed to tell one enquiry from another. */
    contactName: isAffiliation
      ? enquiry.contactPerson || ""
      : enquiry.fullName || "",
    organisation: isAffiliation ? enquiry.collegeName || "" : "",
    emailMasked: maskEmail(enquiry.email),
    /** "" means unclassified; only meaningful for general enquiries. */
    classification: enquiry.generalClassification || "",
    /** "" means unspecified — the public user never picked a topic. */
    inquiryType: normalizeInquiryType(enquiry.inquiryType),
  };
}

/**
 * Full enquiry for the detail view.
 *
 * Every field is listed explicitly so `_id`, `__v` and any future field can
 * never leak through a spread or an accidental `.lean()` passthrough. This is
 * the only place the full contact details and the message are returned.
 */
export function toSafeEnquiry(enquiry: EnquirySource) {
  return {
    reference: enquiry.reference,
    type: enquiry.type,
    status: enquiry.status,
    email: enquiry.email,
    phone: enquiry.phone,
    message: enquiry.message,

    /* General (Contact Us) */
    // Read-only, public-user-owned topic. Canonicalised so an alias written by
    // an older public revision is reported under its single canonical slug.
    inquiryType: normalizeInquiryType(enquiry.inquiryType),
    generalClassification: enquiry.generalClassification ?? "",

    /* Admission */
    fullName: enquiry.fullName ?? "",
    course: enquiry.course ?? "",
    session: enquiry.session ?? "",

    /* College registration / affiliation */
    collegeName: enquiry.collegeName ?? "",
    contactPerson: enquiry.contactPerson ?? "",
    designation: enquiry.designation ?? "",
    address: enquiry.address ?? "",
    district: enquiry.district ?? "",
    collegeType: enquiry.collegeType ?? "",
    purpose: enquiry.purpose ?? "",
    courses: enquiry.courses ?? "",

    createdAt: enquiry.createdAt ?? null,
    updatedAt: enquiry.updatedAt ?? null,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Enquiry =
  mongoose.models.Enquiry ||
  mongoose.model<IEnquiry>("Enquiry", enquirySchema);

export default Enquiry;
