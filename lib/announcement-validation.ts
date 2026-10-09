/**
 * Shared validation + timezone helpers for Announcement Bar Management.
 *
 * Plain functions only (no route, no model, no database access), so the exact
 * same rules are applied on the server (create/update routes) and can also be
 * used by the admin page for its client-side pre-checks. The server always
 * re-validates; the client checks are a UX courtesy.
 *
 * ── Timezone ────────────────────────────────────────────────────────────────
 * Stored timestamps are UTC instants. The admin edits them in IST
 * (Asia/Kolkata = UTC+5:30, no DST). `datetime-local` inputs carry a wall-clock
 * string with no zone, so the helpers below convert explicitly between the IST
 * wall clock and a UTC instant. The browser's local timezone is never used.
 */

/** IST is a fixed UTC+05:30 offset (no daylight saving). */
export const IST_OFFSET_MINUTES = 5 * 60 + 30;
export const IST_TIME_ZONE = "Asia/Kolkata";

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** True when the value looks like a bare `datetime-local` / date wall clock. */
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * Format a stored UTC instant as an IST `YYYY-MM-DDTHH:mm` value for a
 * `<input type="datetime-local">`. Returns "" for a missing/invalid value.
 */
export function toIstInputValue(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  return (
    `${ist.getUTCFullYear()}-${pad2(ist.getUTCMonth() + 1)}-${pad2(ist.getUTCDate())}` +
    `T${pad2(ist.getUTCHours())}:${pad2(ist.getUTCMinutes())}`
  );
}

/**
 * Parse an IST `datetime-local` wall-clock value into a UTC Date.
 * Returns null for anything malformed (e.g. month 13, day 32) — the round-trip
 * check rejects values that JavaScript would otherwise silently roll over.
 */
export function istInputToUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim()
  );
  if (!match) return null;

  const [, y, mo, d, h, mi] = match;
  const utcMs =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) -
    IST_OFFSET_MINUTES * 60_000;
  const date = new Date(utcMs);

  // Reject rolled-over components (e.g. 2026-13-01 or 2026-02-30).
  const expected = `${y}-${mo}-${d}T${h}:${mi}`;
  if (toIstInputValue(date) !== expected) return null;

  return date;
}

/**
 * Human-readable IST rendering for the admin tables, e.g.
 * "01 Aug 2026, 10:00 am IST". Returns "—" for a missing/invalid value.
 */
export function formatIstDateTime(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const formatted = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);

  return `${formatted} IST`;
}

/**
 * Parse an optional scheduling date from a request body.
 *
 *   undefined / null / ""  → { ok: true, data: null }   (no bound)
 *   bare `datetime-local`  → interpreted as IST
 *   ISO string / Date / ms → parsed as an instant
 *
 * Returns a clean 400-able error for anything unparseable — never an
 * accidental epoch date.
 */
export function parseOptionalDate(
  value: unknown
): { ok: true; data: Date | null } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, data: null };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { ok: false, message: "Invalid date/time value." }
      : { ok: true, data: value };
  }

  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? { ok: false, message: "Invalid date/time value." }
      : { ok: true, data: date };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, data: null };

    if (LOCAL_DATETIME_PATTERN.test(trimmed)) {
      const istDate = istInputToUtc(trimmed);
      return istDate
        ? { ok: true, data: istDate }
        : { ok: false, message: "Invalid date/time value." };
    }

    const date = new Date(trimmed);
    return Number.isNaN(date.getTime())
      ? { ok: false, message: "Invalid date/time value." }
      : { ok: true, data: date };
  }

  return { ok: false, message: "Invalid date/time value." };
}

/** Normalise an optional short text field (eyebrow / sub) with a max length. */
export function validateOptionalText(
  value: unknown,
  label: string,
  maxLength: number
): ValidationResult<string> {
  if (value === undefined || value === null) return { ok: true, data: "" };
  if (typeof value !== "string") {
    return { ok: false, message: `${label} must be text.` };
  }
  const text = value.trim();
  if (text.length > maxLength) {
    return { ok: false, message: `${label} cannot exceed ${maxLength} characters.` };
  }
  return { ok: true, data: text };
}

/** Normalise + validate the required headline. */
export function validateHeadline(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, message: "Headline is required." };
  }
  const headline = value.trim();
  if (headline.length > 200) {
    return { ok: false, message: "Headline cannot exceed 200 characters." };
  }
  return { ok: true, data: headline };
}

/** Parse a non-negative display order ("" / null → 0). */
export function parseDisplayOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Validate the CTA destination.
 *
 * Accepts an internal path (`/admissions`) or an absolute `https://` URL.
 * Rejects unsafe/origin-relative schemes (`javascript:`, `data:`), protocol-
 * relative URLs (`//evil.example`) and plain `http://`. Invalid values are
 * rejected outright — never silently rewritten.
 */
export function validateHref(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, message: "Destination link is required." };
  }
  const href = value.trim();
  if (href.length > 500) {
    return { ok: false, message: "Destination link cannot exceed 500 characters." };
  }

  if (href.startsWith("/")) {
    // Internal path — but not a protocol-relative "//host" URL.
    if (href.startsWith("//")) {
      return { ok: false, message: "Destination link must be an internal path or an https URL." };
    }
    if (/[\s<>"'\\]/.test(href)) {
      return { ok: false, message: "Destination link contains invalid characters." };
    }
    return { ok: true, data: href };
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return {
      ok: false,
      message:
        "Destination link must be an internal path (e.g. /admissions) or a valid https URL.",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      message: "External destination links must use https.",
    };
  }

  return { ok: true, data: href };
}

/**
 * Cross-field scheduling check: when both bounds exist, `endAt` must be after
 * `startAt`. Equal bounds are rejected (a zero-length window can never show).
 */
export function validateScheduleWindow(
  startAt: Date | null,
  endAt: Date | null
): ValidationResult<true> {
  if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
    return { ok: false, message: "End date/time must be later than the start date/time." };
  }
  return { ok: true, data: true };
}
