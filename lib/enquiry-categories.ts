/**
 * General-enquiry vocabulary: CATEGORY (keyword) filters and the optional
 * admin CLASSIFICATION.
 *
 * TWO DISTINCT CONCEPTS live here, deliberately:
 *
 *   1. CATEGORY FILTERS — predefined keyword sets used to SEARCH general
 *      enquiries (admission, website issue, result/exam, …). They are applied
 *      at query time, only when the admin picks one, and they NEVER change a
 *      stored enquiry. An enquiry may match several categories (see
 *      "Keyword filtering is not classification" below).
 *
 *   2. CLASSIFICATION — a single optional value an admin may SAVE on an
 *      individual general enquiry (Enquiry.generalClassification) purely for
 *      organisation. It is set by hand and is never derived from — and never
 *      overwritten by — keyword matching.
 *
 * Keyword filtering is NOT classification. A general enquiry whose message is
 * "I cannot download my admission form because the website link is not
 * working" legitimately matches both the Admission and Website Issue keyword
 * sets, and stays unclassified until an admin chooses otherwise.
 *
 * Pure data and pure functions only (no Mongoose, no server-only imports), so
 * both the admin UI and the API can import it. The module is the SINGLE SOURCE
 * OF TRUTH for these values — neither the page nor the route hard-codes a
 * keyword list.
 */

import { escapeRegex } from "@/lib/validation";

/* ── Classification ───────────────────────────────────────────── */

/**
 * Values stored in `Enquiry.generalClassification`.
 *
 * The slugs are stable and inspectable; the human labels live in
 * GENERAL_CLASSIFICATION_LABELS below. `affiliation` is reused intentionally —
 * it is the established stored value for college registration enquiries.
 */
export const GENERAL_CLASSIFICATIONS = [
  "admission",
  "affiliation",
  "website_issue",
  "result_exam",
  "student_portal",
  "course_programme",
  "fees_payment",
  "documents_certificate",
  "contact_office",
  "technical_issue",
  "other",
] as const;

export type GeneralClassification = (typeof GENERAL_CLASSIFICATIONS)[number];

/**
 * "Unclassified" is the EMPTY STRING — never null and never a separate stored
 * token — matching the shared enquiry schema's empty-string convention, so
 * existing documents (which have no such field) already read as unclassified.
 */
export const GENERAL_UNCLASSIFIED = "";

/** Human-readable label for every classification value. */
export const GENERAL_CLASSIFICATION_LABELS: Record<
  GeneralClassification,
  string
> = {
  admission: "Admission",
  affiliation: "College Registration / Affiliation",
  website_issue: "Website Issue",
  result_exam: "Result / Examination",
  student_portal: "Student / Portal",
  course_programme: "Course / Programme",
  fees_payment: "Fees / Payment",
  documents_certificate: "Documents / Certificates",
  contact_office: "Contact / Office Information",
  technical_issue: "Technical Issue",
  other: "Other",
};

export function isGeneralClassification(
  value: unknown
): value is GeneralClassification {
  return (
    typeof value === "string" &&
    (GENERAL_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

/** Label for a stored classification (tolerates "" and legacy values). */
export function generalClassificationLabel(value: string | null | undefined): string {
  if (!value) return "Unclassified";
  return isGeneralClassification(value)
    ? GENERAL_CLASSIFICATION_LABELS[value]
    : value;
}

/* ── Category (keyword) filters ───────────────────────────────── */

/**
 * Fields a category keyword is matched against.
 *
 * The shared enquiry schema has no dedicated `subject` field, so the form's
 * free text lives in `message` — which is why `message` is included here even
 * though the ordinary text search deliberately omits it (see
 * ENQUIRY_SEARCH_FIELDS in @/lib/enquiry-validation).
 */
export const ENQUIRY_CATEGORY_MATCH_FIELDS = [
  "message",
  "fullName",
  "contactPerson",
  "collegeName",
  "course",
  "session",
  "designation",
  "address",
  "district",
  "purpose",
  "courses",
  "email",
  "reference",
] as const;

export interface EnquiryCategoryDefinition {
  /** Stable slug (matches the classification slug for the same topic). */
  key: GeneralClassification;
  /** Human label shown in the Category filter. */
  label: string;
  /**
   * Keywords searched for this category. Whole-word matched (case-insensitive)
   * so the filter stays useful without being aggressive: "admission" finds
   * "admission", but "BA" does not match "banana".
   *
   * `other` carries NO keywords on purpose — it means "no known category
   * matched" and is handled as such by the API.
   */
  keywords: readonly string[];
}

/**
 * The category filter set. MSU-specific terminology is preferred over generic
 * wording (college registration/affiliation rather than "registration";
 * result/examination rather than "grades").
 */
export const ENQUIRY_CATEGORIES: readonly EnquiryCategoryDefinition[] = [
  {
    key: "admission",
    label: GENERAL_CLASSIFICATION_LABELS.admission,
    keywords: [
      "admission",
      "admissions",
      "admit",
      "application",
      "applications",
      "eligibility",
      "admission form",
      "admission process",
      "entrance",
    ],
  },
  {
    key: "affiliation",
    label: GENERAL_CLASSIFICATION_LABELS.affiliation,
    keywords: [
      "affiliation",
      "affiliated college",
      "college registration",
      "college approval",
      "affiliation process",
      "registration",
    ],
  },
  {
    key: "website_issue",
    label: GENERAL_CLASSIFICATION_LABELS.website_issue,
    keywords: [
      "website",
      "web page",
      "page",
      "link",
      "not opening",
      "not loading",
      "broken",
      "broken link",
      "error",
      "website issue",
    ],
  },
  {
    key: "result_exam",
    label: GENERAL_CLASSIFICATION_LABELS.result_exam,
    keywords: [
      "result",
      "results",
      "examination",
      "exam",
      "exams",
      "marks",
      "marksheet",
      "result portal",
    ],
  },
  {
    key: "student_portal",
    label: GENERAL_CLASSIFICATION_LABELS.student_portal,
    keywords: [
      "student portal",
      "portal",
      "login",
      "password",
      "account",
      "sign in",
    ],
  },
  {
    key: "course_programme",
    label: GENERAL_CLASSIFICATION_LABELS.course_programme,
    keywords: [
      "course",
      "courses",
      "programme",
      "program",
      "BCA",
      "BBA",
      "BA",
      "B.Ed",
      "M.Ed",
      "MA",
      "M.Sc",
    ],
  },
  {
    key: "fees_payment",
    label: GENERAL_CLASSIFICATION_LABELS.fees_payment,
    keywords: [
      "fee",
      "fees",
      "payment",
      "online payment",
      "challan",
      "refund",
    ],
  },
  {
    key: "documents_certificate",
    label: GENERAL_CLASSIFICATION_LABELS.documents_certificate,
    keywords: [
      "certificate",
      "document",
      "documents",
      "degree",
      "transcript",
      "verification",
    ],
  },
  {
    key: "contact_office",
    label: GENERAL_CLASSIFICATION_LABELS.contact_office,
    keywords: [
      "contact",
      "office",
      "phone",
      "address",
      "timing",
      "timings",
      "email",
    ],
  },
  {
    key: "technical_issue",
    label: GENERAL_CLASSIFICATION_LABELS.technical_issue,
    keywords: [
      "technical",
      "error",
      "failed",
      "unable",
      "not working",
      "system",
    ],
  },
  {
    key: "other",
    label: GENERAL_CLASSIFICATION_LABELS.other,
    keywords: [],
  },
];

export function isEnquiryCategoryKey(
  value: unknown
): value is GeneralClassification {
  return (
    typeof value === "string" &&
    ENQUIRY_CATEGORIES.some((category) => category.key === value)
  );
}

/** Keywords for one category (empty array for `other`). */
export function categoryKeywords(
  key: GeneralClassification
): readonly string[] {
  return ENQUIRY_CATEGORIES.find((category) => category.key === key)?.keywords ?? [];
}

/**
 * Build a SAFE, case-insensitive alternation pattern for a keyword list.
 *
 * Every keyword is passed through escapeRegex() (so a keyword — or any future
 * stored value — can never alter the pattern) and wrapped in word boundaries so
 * matching stays whole-word. There are no nested quantifiers, so the resulting
 * pattern cannot cause catastrophic backtracking (ReDoS).
 */
function keywordPattern(keywords: readonly string[]): string {
  return keywords
    .filter((keyword) => keyword.trim().length > 0)
    .map((keyword) => `\\b${escapeRegex(keyword.trim())}\\b`)
    .join("|");
}

/** Pattern for one category's keyword set ("" when it has none, e.g. `other`). */
export function categoryKeywordPattern(key: GeneralClassification): string {
  return keywordPattern(categoryKeywords(key));
}

/**
 * Pattern matching EVERY known keyword across all categories — used by the
 * `other` category to find enquiries that match no known topic.
 */
export function allCategoryKeywordPattern(): string {
  return keywordPattern(
    ENQUIRY_CATEGORIES.flatMap((category) => [...category.keywords])
  );
}
