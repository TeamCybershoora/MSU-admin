/**
 * Shared validation helpers.
 */

/**
 * Escape special regex characters in a user-supplied string so it can
 * safely be used inside a MongoDB $regex or new RegExp() without
 * triggering ReDoS or unintended pattern matching.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── Syllabus identifiers ───────────────────────────────────────── */

/** Programme codes as stored (e.g. "BCA", "B.TECH"): 1-20 chars. */
const PROGRAMME_CODE_PATTERN = /^[A-Za-z][A-Za-z .&-]{0,19}$/;

/**
 * Normalise and validate a programme value coming from a request body or
 * query string. Returns the canonical uppercase form, or `null` when invalid.
 *
 * Shared by every syllabus route so a programme identifier is understood
 * identically wherever it is used (no per-programme special cases).
 */
export function parseProgrammeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed || !PROGRAMME_CODE_PATTERN.test(trimmed)) return null;

  return trimmed.toUpperCase();
}

/**
 * Parse a semester value (number or numeric string) into an integer 1-12.
 * Returns `null` when the value is not a valid semester.
 */
export function parseSemesterNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 12 ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;

    const parsed = Number(trimmed);
    return parsed >= 1 && parsed <= 12 ? parsed : null;
  }

  return null;
}

/** RFC 5322 simplified email check. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Exactly 10 digits. */
export function isValidPhone(phone: string): boolean {
  return /^\d{10}$/.test(phone);
}

/** Exactly 12 digits (after stripping hyphens). */
export function isValidAadhar(aadhar: string): boolean {
  return /^\d{12}$/.test(aadhar.replace(/-/g, ""));
}

/** Exactly 12 alphanumeric characters. */
export function isValidAbcId(abcId: string): boolean {
  return /^[A-Za-z0-9]{12}$/.test(abcId);
}

/** Strip hyphens from Aadhar before storing. */
export function sanitizeAadhar(aadhar: string): string {
  return aadhar.replace(/-/g, "");
}

/* ── File upload validation ─────────────────────────────────────── */

/** Maximum accepted PDF size (10 MB). */
export const PDF_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Verify the given bytes actually start with the PDF signature `%PDF-`.
 *
 * The browser-supplied MIME type and file extension are attacker-controlled,
 * so the file signature is the authoritative check — this rejects images or
 * executables merely renamed to `.pdf`.
 */
export function isPdfBuffer(data: Uint8Array): boolean {
  // Needs the 5-byte signature plus at least one byte of PDF body.
  if (data.length < 6) return false;
  return (
    data[0] === 0x25 && // %
    data[1] === 0x50 && // P
    data[2] === 0x44 && // D
    data[3] === 0x46 && // F
    data[4] === 0x2d //   -
  );
}

/**
 * Produce a safe display/storage name for an uploaded PDF.
 *
 * Strips any directory component (defeating `../` path traversal), removes
 * characters that are unsafe in headers or file listings, caps the length and
 * guarantees a `.pdf` suffix. The result is used only as a label/storage key —
 * never as a filesystem path.
 */
export function safePdfFilename(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[^\w .()-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  const safe = cleaned || "syllabus";
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
}

/**
 * Render a filename safe to embed in a Content-Disposition header.
 * Prevents header injection via quotes, newlines or non-ASCII bytes.
 */
export function headerSafeFilename(name: string): string {
  return (name || "syllabus.pdf").replace(/[^\w .()-]/g, "_").slice(0, 120);
}
