/**
 * Shared enquiry vocabulary for the Admin Portal.
 *
 * SINGLE SOURCE OF TRUTH for the values stored on the shared `enquiries`
 * collection (types, statuses, districts, college types, field limits and the
 * public reference format).
 *
 * These values are DEFINED BY THE PUBLIC MSU ENQUIRY SYSTEM and are mirrored
 * here verbatim. Never rename, re-case or reinterpret them: the public Contact
 * page writes this collection and the Admin Portal reads it, so any drift in
 * these strings would silently make stored enquiries unreadable or unwritable.
 *
 *   - the stored status is `in_review` — never `review`
 *   - non-applicable type-specific fields are stored as `""`, never null
 *   - `email` is stored lowercased, `phone` normalised to 10 digits,
 *     `reference` uppercased
 *
 * Pure data and pure functions only (no Mongoose, no server-only imports), so
 * client components may import it freely.
 */

/* ── Enquiry types ───────────────────────────────────────────── */

/**
 * Enquiry kinds. Mirrors `ENQUIRY_TYPES` in the public MSU project.
 *
 * `general` is the Contact-Us enquiry type. It was appended — the established
 * `admission` and `affiliation` values are NEVER renamed or re-cased, so every
 * existing document remains readable and writable.
 */
export const ENQUIRY_TYPES = ["admission", "affiliation", "general"] as const;
export type EnquiryType = (typeof ENQUIRY_TYPES)[number];

/* ── Statuses ────────────────────────────────────────────────── */

/**
 * Workflow status. Mirrors `ENQUIRY_STATUSES` in the public MSU project.
 * The public API only ever writes `new` (the schema default); the remaining
 * values are managed here.
 */
export const ENQUIRY_STATUSES = [
  "new",
  "in_review",
  "responded",
  "closed",
] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/** The status every public enquiry is created with. */
export const ENQUIRY_DEFAULT_STATUS: EnquiryStatus = "new";

/* ── Enum membership helpers ─────────────────────────────────── */

export function isEnquiryType(value: unknown): value is EnquiryType {
  return (
    typeof value === "string" &&
    (ENQUIRY_TYPES as readonly string[]).includes(value)
  );
}

export function isEnquiryStatus(value: unknown): value is EnquiryStatus {
  return (
    typeof value === "string" &&
    (ENQUIRY_STATUSES as readonly string[]).includes(value)
  );
}

/* ── College registration / affiliation vocabulary ───────────── */

/** Mirrors `COLLEGE_TYPES` in the public MSU project. */
export const COLLEGE_TYPES = [
  "Government",
  "Government Aided",
  "Private",
  "Other",
] as const;
export type CollegeType = (typeof COLLEGE_TYPES)[number];

/** Mirrors `DISTRICTS` in the public MSU project. */
export const DISTRICTS = ["Saharanpur", "Shamli", "Muzaffarnagar"] as const;
export type District = (typeof DISTRICTS)[number];

export function isCollegeType(value: unknown): value is CollegeType {
  return (
    typeof value === "string" &&
    (COLLEGE_TYPES as readonly string[]).includes(value)
  );
}

export function isValidDistrict(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (DISTRICTS as readonly string[]).includes(value)
  );
}

/* ── Reference number ────────────────────────────────────────── */

/** Prefix used by every public enquiry reference. */
export const ENQUIRY_REFERENCE_PREFIX = "MSU-ENQ-";

/**
 * Shape of a public enquiry reference: `MSU-ENQ-` plus 8 characters of
 * Crockford-style Base32 (no I, L, O or U) — e.g. `MSU-ENQ-48J7PRKQ`.
 *
 * This is a FORMAT check only; it is not proof that the enquiry exists.
 */
export const ENQUIRY_REFERENCE_PATTERN =
  /^MSU-ENQ-[0-9A-HJKMNP-TV-Z]{8}$/;

export function isEnquiryReference(value: unknown): value is string {
  return typeof value === "string" && ENQUIRY_REFERENCE_PATTERN.test(value);
}

/* ── Length limits (mirrored from the public schema) ─────────── */

export const MESSAGE_MIN_LENGTH = 10;
export const MESSAGE_MAX_LENGTH = 1000;

/** Maximum accepted length for every stored enquiry field. */
export const ENQUIRY_FIELD_LIMITS = {
  fullName: 80,
  email: 120,
  phone: 20,
  course: 120,
  session: 40,
  collegeName: 160,
  contactPerson: 80,
  designation: 80,
  address: 240,
  district: 40,
  collegeType: 40,
  purpose: 200,
  courses: 200,
  message: MESSAGE_MAX_LENGTH,
} as const;

/* ── Contact-number handling ─────────────────────────────────── */

/**
 * Normalise a contact number to 10 local digits, accepting an optional
 * +91 / 91 / 0 prefix and any spacing, dashes or brackets a user may type
 * (e.g. "+91 98765 43210" → "9876543210").
 *
 * The public Contact page stores the normalised form, so an Admin-side write
 * path must use the same rule to stay compatible. Never throws.
 */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    return digits.slice(1);
  }
  return digits;
}

/** Exactly 10 digits after normalisation. */
export function isValidContactNumber(value: string): boolean {
  return /^\d{10}$/.test(normalizePhone(value));
}

/* ── General-enquiry inquiry type (PUBLIC user-selected topic) ─ */

/**
 * The topics a PUBLIC submitter chooses on the Contact page's General Enquiry
 * form. Stored in `Enquiry.inquiryType` and DEFINED BY THE PUBLIC MSU ENQUIRY
 * SYSTEM, so — like everything else in this module — the slugs are mirrored
 * verbatim and never renamed or re-cased here.
 *
 * Canonical values (also the option values offered by the Admin filter).
 *
 * ALIASES: the public system has used two spellings for two of these topics
 * across its revisions (`result_exam` / `documents_certificate` versus
 * `result_examination` / `documents_certificates`). BOTH are accepted, so a
 * document written with either spelling stays readable and filterable instead
 * of silently disappearing from the filter:
 *
 *   - normalizeInquiryType() folds an alias into its canonical value for
 *     display and for the API response;
 *   - inquiryTypeMatchValues() expands a canonical value into every stored
 *     spelling the query must match.
 *
 * Distinct from `generalClassification` (see @/lib/enquiry-categories), which
 * an ADMIN saves by hand later. The public user's choice NEVER overwrites the
 * classification, and the classification NEVER overwrites it.
 */
export const GENERAL_INQUIRY_TYPES = [
  "admission",
  "affiliation",
  "technical_issue",
  "result_examination",
  "student_portal",
  "course_programme",
  "fees_payment",
  "documents_certificates",
  "contact_office",
  "other",
] as const;
export type GeneralInquiryType = (typeof GENERAL_INQUIRY_TYPES)[number];

/** Alternate stored spellings → the canonical value they must be read as. */
export const INQUIRY_TYPE_ALIASES: Readonly<Record<string, GeneralInquiryType>> =
  {
    result_exam: "result_examination",
    documents_certificate: "documents_certificates",
  };

/** Filter state for records written before `inquiryType` existed. */
export const INQUIRY_TYPE_UNSPECIFIED = "unspecified";

/** Canonical human label for every supported inquiry type. */
export const GENERAL_INQUIRY_TYPE_LABELS: Record<GeneralInquiryType, string> = {
  admission: "Admission Inquiry",
  affiliation: "College Affiliation",
  technical_issue: "Technical Issue",
  result_examination: "Result / Examination",
  student_portal: "Student / Portal",
  course_programme: "Course / Programme",
  fees_payment: "Fees / Payment",
  documents_certificates: "Documents / Certificates",
  contact_office: "Contact / Office Information",
  other: "Other",
};

/** True when `value` is a canonical inquiry type. */
export function isGeneralInquiryType(
  value: unknown
): value is GeneralInquiryType {
  return (
    typeof value === "string" &&
    (GENERAL_INQUIRY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Fold any stored `inquiryType` value into its canonical slug.
 *
 * Returns "" for a missing / null / empty value — the representation used by
 * records that predate the field — and the untouched input for a value that
 * is neither canonical nor a known alias (never hidden, so unexpected data
 * stays visible rather than being silently dropped).
 */
export function normalizeInquiryType(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (isGeneralInquiryType(trimmed)) return trimmed;
  return INQUIRY_TYPE_ALIASES[trimmed] ?? trimmed;
}

/** Human label for a stored inquiry type (missing → "Unspecified"). */
export function generalInquiryTypeLabel(value: unknown): string {
  const canonical = normalizeInquiryType(value);
  if (!canonical) return "Unspecified";
  return isGeneralInquiryType(canonical)
    ? GENERAL_INQUIRY_TYPE_LABELS[canonical]
    : canonical;
}

/**
 * Every stored spelling a filter for the canonical `value` must match: the
 * canonical slug plus each alias that resolves to it. Used to build an `$in`
 * so alias-bearing documents are still returned.
 */
export function inquiryTypeMatchValues(value: GeneralInquiryType): string[] {
  const match: string[] = [value];
  for (const [alias, canonical] of Object.entries(INQUIRY_TYPE_ALIASES)) {
    if (canonical === value) match.push(alias);
  }
  return match;
}
