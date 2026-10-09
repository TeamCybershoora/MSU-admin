/**
 * Shared validation for the Admin enquiry API.
 *
 * Kept as plain functions (no route, no model, no database access) so the same
 * rules apply wherever enquiry data is read or changed. Primitives that already
 * exist project-wide are reused rather than re-implemented:
 *   - escapeRegex() from @/lib/validation for every user-supplied pattern
 *   - the enum vocabulary from @/lib/enquiry-types
 *
 * This module is CLIENT-SAFE (pure functions only) so the enquiries page can
 * reuse the allowed-transition list to build its status control.
 */

import {
  ENQUIRY_STATUSES,
  INQUIRY_TYPE_ALIASES,
  INQUIRY_TYPE_UNSPECIFIED,
  inquiryTypeMatchValues,
  isEnquiryReference,
  isEnquiryStatus,
  isEnquiryType,
  isGeneralInquiryType,
  type EnquiryStatus,
  type EnquiryType,
  type GeneralInquiryType,
} from "@/lib/enquiry-types";
import {
  ENQUIRY_CATEGORY_MATCH_FIELDS,
  GENERAL_CLASSIFICATIONS,
  GENERAL_UNCLASSIFIED,
  allCategoryKeywordPattern,
  categoryKeywordPattern,
  isEnquiryCategoryKey,
  isGeneralClassification,
  type GeneralClassification,
} from "@/lib/enquiry-categories";
import { escapeRegex } from "@/lib/validation";

/* ── Pagination ──────────────────────────────────────────────── */

export const ENQUIRY_DEFAULT_PAGE = 1;
export const ENQUIRY_DEFAULT_LIMIT = 20;
export const ENQUIRY_MAX_LIMIT = 100;

export interface EnquiryPagination {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Read a positive integer from a query parameter.
 *
 * Anything that is not a plain run of digits (empty, "abc", "-1", "1.5",
 * "1e3", or a value too large to be a safe integer) falls back to `fallback`.
 * This is deliberately stricter than `parseInt`, which returns NaN for
 * non-numeric input and would otherwise poison `skip`/`limit` and turn an
 * invalid query string into a 500.
 */
function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) return fallback;

  return value;
}

/**
 * Parse `?page=` and `?limit=` without ever producing NaN.
 * `limit` is clamped to ENQUIRY_MAX_LIMIT, matching the other admin list APIs.
 */
export function parseEnquiryPagination(
  searchParams: URLSearchParams
): EnquiryPagination {
  const page = parsePositiveInt(
    searchParams.get("page"),
    ENQUIRY_DEFAULT_PAGE
  );
  const limit = Math.min(
    ENQUIRY_MAX_LIMIT,
    parsePositiveInt(searchParams.get("limit"), ENQUIRY_DEFAULT_LIMIT)
  );

  return { page, limit, skip: (page - 1) * limit };
}

/* ── Search ──────────────────────────────────────────────────── */

/** Longest accepted search term (longer input is truncated, not rejected). */
export const ENQUIRY_SEARCH_MAX_LENGTH = 120;

/**
 * Fields a search term is matched against.
 *
 * Deliberately EXCLUDES `message`: free-text message search is neither indexed
 * nor cheap, and it exposes the most sensitive content in every result row.
 * The full message is still visible by opening the enquiry.
 */
export const ENQUIRY_SEARCH_FIELDS = [
  "reference",
  "email",
  "phone",
  "fullName",
  "contactPerson",
  "collegeName",
] as const;

/**
 * Additional fields searched for GENERAL enquiries only.
 *
 * A general (Contact Us) enquiry has no type-specific fields, so its whole
 * description lives in `message`. Searching it is the point of the page — the
 * form asks an open question and the admin finds it by its wording. Admission
 * and affiliation searches stay unchanged (no message scan), exactly as before.
 */
export const GENERAL_ENQUIRY_EXTRA_SEARCH_FIELDS = ["message"] as const;

/** Trim and cap a user-supplied search term. Returns "" when absent. */
export function parseEnquirySearch(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, ENQUIRY_SEARCH_MAX_LENGTH);
}

/* ── Filters ─────────────────────────────────────────────────── */

/**
 * Parse the `type` filter. Unknown values (including the "All" sentinel and
 * anything out of the enum) mean "no filter" rather than an error.
 */
export function parseEnquiryTypeFilter(
  raw: string | null | undefined
): EnquiryType | "" {
  const value = typeof raw === "string" ? raw.trim() : "";
  return isEnquiryType(value) ? value : "";
}

/** Parse the `status` filter. Unknown values mean "no filter". */
export function parseEnquiryStatusFilter(
  raw: string | null | undefined
): EnquiryStatus | "" {
  const value = typeof raw === "string" ? raw.trim() : "";
  return isEnquiryStatus(value) ? value : "";
}

/* ── General-enquiry filters (category + saved classification) ── */

/**
 * Parse the `category` filter (a KEYWORD search category).
 *
 * Category matching is a query-time convenience and never touches the stored
 * enquiry. Unknown values — including the "All" sentinel — mean "no filter".
 */
export function parseEnquiryCategoryFilter(
  raw: string | null | undefined
): GeneralClassification | "" {
  const value = typeof raw === "string" ? raw.trim() : "";
  return isEnquiryCategoryKey(value) ? value : "";
}

/**
 * Parse the `classification` filter (the SAVED admin classification).
 *
 * Distinct from `category`: this filters on what an admin explicitly stored,
 * not on keyword matches. The literal `unclassified` selects enquiries with no
 * saved classification; unknown values mean "no filter".
 */
export function parseEnquiryClassificationFilter(
  raw: string | null | undefined
): GeneralClassification | "unclassified" | "" {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "unclassified") return "unclassified";
  return isGeneralClassification(value) ? value : "";
}

/* ── List query ──────────────────────────────────────────────── */

/**
 * Parse the `inquiryType` filter — the PUBLIC user's selected topic.
 *
 * This is a THIRD, distinct concept alongside `category` (a keyword search
 * over the text) and `classification` (the value an admin saved):
 * `inquiryType` is read straight from the stored field, so it works no matter
 * how the message is worded.
 *
 * Accepted: a canonical slug, one of the accepted stored aliases (folded to
 * its canonical value), or the `unspecified` sentinel for records written
 * before the field existed. `all`, `All` and every other value — including
 * anything that could be read as a MongoDB operator — mean "no filter"; raw
 * request text is NEVER placed in the query.
 */
export function parseInquiryTypeFilter(
  raw: string | null | undefined
): GeneralInquiryType | typeof INQUIRY_TYPE_UNSPECIFIED | "" {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (value === INQUIRY_TYPE_UNSPECIFIED) return INQUIRY_TYPE_UNSPECIFIED;
  if (isGeneralInquiryType(value)) return value;
  return INQUIRY_TYPE_ALIASES[value] ?? "";
}

/** Every filter GET /api/admin/enquiries understands, already parsed. */
export interface EnquiryListFilters {
  type: EnquiryType | "";
  status: EnquiryStatus | "";
  search: string;
  category: GeneralClassification | "";
  classification: GeneralClassification | "unclassified" | "";
  inquiryType: GeneralInquiryType | typeof INQUIRY_TYPE_UNSPECIFIED | "";
}

/**
 * Build the MongoDB filter for GET /api/admin/enquiries.
 *
 * Takes ALREADY-PARSED values, never raw query strings: a key that is absent
 * from the returned object simply is not queried, so no request value can
 * become a field name or an operator. Search terms go through escapeRegex()
 * and keyword patterns come from @/lib/enquiry-categories.
 *
 * THE FILTER IS BUILT HERE, IN THE QUERY HANDED TO THE DATABASE — so
 * `skip`/`limit` always paginate the whole filtered set. Client-side
 * pagination of whatever happens to be on screen is deliberately impossible:
 * this object is the only thing `Enquiry.find()` and `countDocuments()` see.
 */
export function buildEnquiryListQuery(
  filters: EnquiryListFilters
): Record<string, unknown> {
  const query: Record<string, unknown> = {};

  // `inquiryType` exists only on general enquiries, so without an explicit
  // type it implies one — otherwise the `unspecified` filter would sweep up
  // every admission and affiliation enquiry (none of which carry the field).
  const type = filters.type || (filters.inquiryType ? "general" : "");

  if (type) query.type = type;
  if (filters.status) query.status = filters.status;

  // "unclassified" is the absence of a value, not a value: existing documents
  // may carry "", null, or no field at all.
  if (filters.classification) {
    query.generalClassification =
      filters.classification === "unclassified"
        ? { $in: ["", null] }
        : filters.classification;
  }

  if (filters.inquiryType) {
    // The stored field ONLY — never the message text — so the topic filter
    // works even when the wording never mentions it. `$in: [null, ""]` matches
    // a missing field, null and "", i.e. every record that predates the field.
    query.inquiryType =
      filters.inquiryType === INQUIRY_TYPE_UNSPECIFIED
        ? { $in: [null, ""] }
        : { $in: inquiryTypeMatchValues(filters.inquiryType) };
  }

  // Search and category are combined under $and (both may produce a $or, and a
  // query object cannot hold two $or keys).
  const and: Record<string, unknown>[] = [];

  if (filters.search) {
    // escapeRegex() neutralises regex metacharacters, so a search term can
    // never alter the pattern (ReDoS / unintended matching).
    const pattern = escapeRegex(filters.search);
    const fields =
      type === "general"
        ? [...ENQUIRY_SEARCH_FIELDS, ...GENERAL_ENQUIRY_EXTRA_SEARCH_FIELDS]
        : ENQUIRY_SEARCH_FIELDS;

    and.push({
      $or: fields.map((field) => ({
        [field]: { $regex: pattern, $options: "i" },
      })),
    });
  }

  if (filters.category) {
    // Both patterns are built by @/lib/enquiry-categories from escaped,
    // word-bounded keywords — the request supplies only a validated category
    // KEY, never a pattern of its own.
    if (filters.category === "other") {
      // "Other" = content matching NONE of the known keyword sets.
      const known = allCategoryKeywordPattern();
      if (known) {
        and.push({
          $nor: ENQUIRY_CATEGORY_MATCH_FIELDS.map((field) => ({
            [field]: { $regex: known, $options: "i" },
          })),
        });
      }
    } else {
      const pattern = categoryKeywordPattern(filters.category);
      if (pattern) {
        and.push({
          $or: ENQUIRY_CATEGORY_MATCH_FIELDS.map((field) => ({
            [field]: { $regex: pattern, $options: "i" },
          })),
        });
      }
    }
  }

  if (and.length) query.$and = and;

  return query;
}

/* ── Status workflow ─────────────────────────────────────────── */

/**
 * Legal status transitions.
 *
 * The public project defines the four status VALUES but no transitions, so the
 * forward path plus reopening is fixed here and enforced server-side:
 *
 *   new        → in_review | closed
 *   in_review  → responded | closed
 *   responded  → closed    | in_review   (reopen)
 *   closed     → in_review               (reopen)
 *
 * Setting a status to its current value is never a transition.
 */
export const ENQUIRY_STATUS_TRANSITIONS: Record<
  EnquiryStatus,
  readonly EnquiryStatus[]
> = {
  new: ["in_review", "closed"],
  in_review: ["responded", "closed"],
  responded: ["closed", "in_review"],
  closed: ["in_review"],
};

/** Statuses that may currently be moved to from `from`. */
export function allowedTransitions(
  from: EnquiryStatus | string
): readonly EnquiryStatus[] {
  return isEnquiryStatus(from) ? ENQUIRY_STATUS_TRANSITIONS[from] : [];
}

/** True when `from → to` is a legal, meaningful transition. */
export function canTransition(
  from: EnquiryStatus | string,
  to: unknown
): to is EnquiryStatus {
  if (!isEnquiryStatus(to)) return false;
  if (to === from) return false;
  return allowedTransitions(from).includes(to);
}

/** Human-readable, stable order used by filters and the workflow legend. */
export const ENQUIRY_STATUS_ORDER: readonly EnquiryStatus[] = ENQUIRY_STATUSES;

/* ── Route identifier ────────────────────────────────────────── */

/**
 * Parse the enquiry identifier used in Admin URLs.
 *
 * The human-facing REFERENCE is the identifier — deliberately not the MongoDB
 * ObjectId — so it is readable, quotable over the phone, and durable in the
 * audit trail after the document is deleted. Returns null when the segment is
 * not a well-formed reference (the caller answers 400).
 */
export function parseEnquiryReferenceParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim().toUpperCase();
  return isEnquiryReference(value) ? value : null;
}

/* ── Reply rules ─────────────────────────────────────────────── */

export const ENQUIRY_REPLY_MIN_LENGTH = 10;
export const ENQUIRY_REPLY_MAX_LENGTH = 5000;

/**
 * Statuses a reply may be sent from. A closed enquiry must be reopened first,
 * so a reply can never silently move a closed enquiry back to `responded`.
 */
export const ENQUIRY_REPLY_ALLOWED_STATUSES: readonly EnquiryStatus[] = [
  "new",
  "in_review",
  "responded",
];

export function canReplyFrom(status: EnquiryStatus | string): boolean {
  return isEnquiryStatus(status)
    ? ENQUIRY_REPLY_ALLOWED_STATUSES.includes(status)
    : false;
}

export type EnquiryValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Validate the admin's reply body.
 *
 * Only the message is accepted. The recipient is NEVER taken from the request:
 * the enquiry's stored `email` is the authoritative destination (see
 * app/api/admin/enquiries/[id]/reply/route.ts).
 */
export function validateReplyMessage(
  raw: unknown
): EnquiryValidationResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, message: "Reply message is required." };
  }

  const message = raw.trim();
  if (!message) {
    return { ok: false, message: "Reply message is required." };
  }
  if (message.length < ENQUIRY_REPLY_MIN_LENGTH) {
    return {
      ok: false,
      message: `Reply message must be at least ${ENQUIRY_REPLY_MIN_LENGTH} characters.`,
    };
  }
  if (message.length > ENQUIRY_REPLY_MAX_LENGTH) {
    return {
      ok: false,
      message: `Reply message must be at most ${ENQUIRY_REPLY_MAX_LENGTH} characters.`,
    };
  }

  return { ok: true, value: message };
}

/** Validate a requested status change value. Unknown values are rejected. */
export function validateStatusInput(
  raw: unknown
): EnquiryValidationResult<EnquiryStatus> {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, message: "Status is required." };
  }

  const value = raw.trim();
  if (!isEnquiryStatus(value)) {
    return {
      ok: false,
      message: `Status must be one of: ${ENQUIRY_STATUSES.join(", ")}.`,
    };
  }

  return { ok: true, value };
}

/**
 * Validate a requested classification change.
 *
 * Accepts one of the allowed slugs, or an empty string to clear the
 * classification ("Unclassified"). Every other value — including a value the
 * client invents — is rejected, so the stored field can only ever hold a known
 * slug. Returns the canonical value to store (``""`` for unclassified).
 */
export function validateClassificationInput(
  raw: unknown
): EnquiryValidationResult<GeneralClassification | ""> {
  if (typeof raw !== "string") {
    return { ok: false, message: "Classification is required." };
  }

  const value = raw.trim();
  if (value === GENERAL_UNCLASSIFIED) {
    return { ok: true, value: GENERAL_UNCLASSIFIED };
  }
  if (!isGeneralClassification(value)) {
    return {
      ok: false,
      message: `Classification must be one of: ${GENERAL_CLASSIFICATIONS.join(
        ", "
      )}, or empty to unclassify.`,
    };
  }

  return { ok: true, value };
}
