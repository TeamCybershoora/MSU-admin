/**
 * Shared validation for the Recruitment admin API.
 *
 * Plain functions only (no route, no model, no database access), so the exact
 * same rules are applied wherever recruitment data enters the system — the
 * create route, the update route and the admin page's client-side pre-checks.
 * The server always re-validates; the client checks are a UX courtesy.
 */

import {
  RECRUITMENT_DESCRIPTION_MAX,
  RECRUITMENT_STATUSES,
  RECRUITMENT_TYPES,
  RECRUITMENT_TITLE_MAX,
  type RecruitmentStatus,
  type RecruitmentType,
} from "@/lib/recruitment-types";

/** Discriminated result used by the validators below. */
export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

/** Parse a recruitment `type` value. */
export function parseRecruitmentType(value: unknown): RecruitmentType | null {
  return typeof value === "string" &&
    (RECRUITMENT_TYPES as readonly string[]).includes(value)
    ? (value as RecruitmentType)
    : null;
}

/** Parse a recruitment `status` value. */
export function parseRecruitmentStatus(value: unknown): RecruitmentStatus | null {
  return typeof value === "string" &&
    (RECRUITMENT_STATUSES as readonly string[]).includes(value)
    ? (value as RecruitmentStatus)
    : null;
}

/**
 * Parse an optional display-order value into a non-negative integer.
 * `undefined` / `null` / "" → 0 (the schema default).
 */
export function parseDisplayOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Parse a publish/issue date from a form value.
 *
 * Accepts an ISO date (`2026-07-15`), a full ISO timestamp, a Date or an
 * epoch-ms number. Returns `null` for anything unparseable so callers respond
 * with a clean 400 rather than persisting an Invalid Date.
 */
export function parsePublishedDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/** Normalise + validate a title. Empty and over-long values are rejected. */
export function validateTitle(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, message: "Title is required." };
  }
  const title = value.trim();
  if (title.length > RECRUITMENT_TITLE_MAX) {
    return {
      ok: false,
      message: `Title cannot exceed ${RECRUITMENT_TITLE_MAX} characters.`,
    };
  }
  return { ok: true, data: title };
}

/** Normalise an optional description. */
export function validateDescription(value: unknown): ValidationResult<string> {
  if (value === undefined || value === null) return { ok: true, data: "" };
  if (typeof value !== "string") {
    return { ok: false, message: "Description must be text." };
  }
  const description = value.trim();
  if (description.length > RECRUITMENT_DESCRIPTION_MAX) {
    return {
      ok: false,
      message: `Description cannot exceed ${RECRUITMENT_DESCRIPTION_MAX} characters.`,
    };
  }
  return { ok: true, data: description };
}
