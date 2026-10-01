/**
 * Automatic ENQUIRY ACKNOWLEDGEMENT templates — admin-manageable content for
 * the confirmation email sent when a public website enquiry is created.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SCOPE
 *   This module owns the CONTENT of the automatic acknowledgement only.
 *   The separate admin REPLY workflow (lib/email/templates.ts +
 *   lib/email/provider.ts) is untouched by this module.
 *
 * STORAGE CONTRACT (shared with the public MSU project)
 *   Templates are stored in the existing SiteConfig key-value collection —
 *   no new collection, no new schema:
 *     enquiry_ack_admission   → JSON { "subject": "...", "body": "..." }
 *     enquiry_ack_affiliation → JSON { "subject": "...", "body": "..." }
 *     enquiry_ack_general     → JSON { "subject": "...", "body": "..." }
 *   A missing / empty / corrupt / invalid record falls back PER THE
 *   resolveAckTemplate() rules to ENQUIRY_ACK_DEFAULTS, so a damaged
 *   configuration can never produce an empty email.
 *
 * SAFETY
 *   - Pure data and pure functions only (no Mongoose, no server-only
 *     imports): the admin UI imports this module for local previews and the
 *     server imports it for validation and rendering.
 *   - Placeholders are a CONTROLLED {{name}} system replaced by plain
 *     string substitution. There is no eval, no template compilation and no
 *     code execution of any kind; unknown placeholders are left as literal
 *     text in renders and are REJECTED on save.
 *   - The rendered subject is sanitised to a single line so no stored value
 *     can inject an additional email header.
 *   - Bodies are treated as PLAIN TEXT: the HTML rendering escapes all
 *     content (template text and substituted values) before it is marked up.
 */

import {
  isEnquiryType,
  type EnquiryType,
} from "@/lib/enquiry-types";
import { escapeHtml } from "./templates";

/* ── Template shape and limits ────────────────────────────────────────── */

export interface EnquiryAckTemplate {
  subject: string;
  body: string;
}

export const ACK_SUBJECT_MAX_LENGTH = 200;
export const ACK_BODY_MAX_LENGTH = 5000;

/* ── Controlled placeholder vocabulary ────────────────────────────────── */

/**
 * Placeholders each template may use — BARE names (the UI formats them as
 * `{{name}}`). Only fields that exist in the shared enquiry schema for that
 * enquiry type are exposed; admission templates cannot reference
 * college-registration fields and vice versa.
 */
export const ENQUIRY_ACK_PLACEHOLDERS: Record<
  EnquiryType,
  readonly string[]
> = {
  admission: ["fullName", "course", "session", "email", "phone", "reference"],
  affiliation: [
    "contactPerson",
    "collegeName",
    "designation",
    "district",
    "collegeType",
    "email",
    "phone",
    "reference",
  ],
  // A general (Contact Us) enquiry uses only the fields shared by every type.
  general: ["fullName", "email", "phone", "reference"],
};

/** Display form of a placeholder, e.g. `fullName` → `{{fullName}}`. */
export function formatAckPlaceholder(name: string): string {
  return `{{${name}}}`;
}

/** Every `{{...}}` token in a text, contents trimmed, in order of appearance. */
function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    found.push(match[1].trim());
  }
  return found;
}

/* ── Application defaults (the safe fallback) ─────────────────────────── */

/**
 * Built-in acknowledgement content used whenever no valid customised
 * template is stored. These defaults reference only real schema fields, so a
 * fresh installation (empty SiteConfig) sends exactly as before.
 */
export const ENQUIRY_ACK_DEFAULTS: Record<EnquiryType, EnquiryAckTemplate> = {
  admission: {
    subject: "Thank you for contacting Maa Shakumbhari University",
    body: `Dear {{fullName}},

Thank you for contacting Maa Shakumbhari University.

We have received your admission enquiry successfully. Your enquiry reference is {{reference}}.
Our team will review your enquiry and get back to you soon.

Regards,
Maa Shakumbhari University`,
  },
  affiliation: {
    subject: "Thank you for contacting Maa Shakumbhari University",
    body: `Dear {{contactPerson}},

Thank you for contacting Maa Shakumbhari University regarding college registration.

We have received your enquiry from {{collegeName}} successfully. Your enquiry reference is {{reference}}.
Our team will review the information and get back to you soon.

Regards,
Maa Shakumbhari University`,
  },
  general: {
    subject: "Thank you for contacting Maa Shakumbhari University",
    body: `Dear {{fullName}},

Thank you for contacting Maa Shakumbhari University.

We have received your enquiry successfully. Your enquiry reference is {{reference}}.
Our team will review your message and get back to you soon.

Regards,
Maa Shakumbhari University`,
  },
};

/* ── SiteConfig keys (shared storage contract) ────────────────────────── */

/** SiteConfig keys holding the JSON template for each enquiry type. */
export const ENQUIRY_ACK_CONFIG_KEYS: Record<EnquiryType, string> = {
  admission: "enquiry_ack_admission",
  affiliation: "enquiry_ack_affiliation",
  general: "enquiry_ack_general",
};

/* ── Sample data (local preview + tests) ──────────────────────────────── */

/**
 * Sample enquiry values for the admin preview and offline tests. Rendering
 * these NEVER sends an email — preview is a pure local function.
 */
export const ENQUIRY_ACK_SAMPLE_VALUES: Record<
  EnquiryType,
  Record<string, string>
> = {
  admission: {
    fullName: "Example Student",
    course: "B.Tech (Computer Science)",
    session: "2026-27",
    email: "example@example.com",
    phone: "9876543210",
    reference: "MSU-ENQ-TEST",
  },
  affiliation: {
    contactPerson: "Example Contact Person",
    collegeName: "Example College of Engineering",
    designation: "Principal",
    district: "Saharanpur",
    collegeType: "Private",
    email: "example@example.com",
    phone: "9876543210",
    reference: "MSU-ENQ-TEST",
  },
  general: {
    fullName: "Example Visitor",
    email: "example@example.com",
    phone: "9876543210",
    reference: "MSU-ENQ-TEST",
  },
};

/* ── Validation (server-side save rule) ───────────────────────────────── */

export type AckValidationResult =
  | { ok: true; value: EnquiryAckTemplate }
  | { ok: false; message: string };

/** Control characters that must never reach an email subject line. */
const SUBJECT_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Disallowed control characters in a body (CR/LF/TAB are fine). */
const BODY_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Validate one acknowledgement template for one enquiry type.
 *
 * Rejects: wrong shape, empty subject/body, over-long content, control
 * characters (subject must be a single line), and ANY `{{...}}` placeholder
 * outside that type's whitelist — typos surface at save time instead of
 * leaking literal braces into a sent email.
 */
export function validateAckTemplate(
  type: unknown,
  input: unknown
): AckValidationResult {
  if (!isEnquiryType(type)) {
    return { ok: false, message: "Invalid enquiry type." };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Template is required." };
  }

  const raw = input as { subject?: unknown; body?: unknown };
  const allowed = ENQUIRY_ACK_PLACEHOLDERS[type];

  if (typeof raw.subject !== "string") {
    return { ok: false, message: "Subject is required." };
  }
  const subject = raw.subject.trim();
  if (!subject) {
    return { ok: false, message: "Subject is required." };
  }
  if (subject.length > ACK_SUBJECT_MAX_LENGTH) {
    return {
      ok: false,
      message: `Subject must be at most ${ACK_SUBJECT_MAX_LENGTH} characters.`,
    };
  }
  if (SUBJECT_CONTROL_CHARS.test(subject)) {
    return {
      ok: false,
      message: "Subject must be a single line without control characters.",
    };
  }

  if (typeof raw.body !== "string") {
    return { ok: false, message: "Email body is required." };
  }
  const body = raw.body.trim();
  if (!body) {
    return { ok: false, message: "Email body is required." };
  }
  if (body.length > ACK_BODY_MAX_LENGTH) {
    return {
      ok: false,
      message: `Email body must be at most ${ACK_BODY_MAX_LENGTH} characters.`,
    };
  }
  if (BODY_CONTROL_CHARS.test(body)) {
    return { ok: false, message: "Email body contains invalid characters." };
  }

  const used = [...extractPlaceholders(subject), ...extractPlaceholders(body)];
  const unknown = used.find((name) => !allowed.includes(name));
  if (unknown !== undefined) {
    return {
      ok: false,
      message: `Unknown placeholder "${formatAckPlaceholder(
        unknown || ""
      )}". Allowed placeholders: ${allowed
        .map(formatAckPlaceholder)
        .join(", ")}.`,
    };
  }

  return { ok: true, value: { subject, body } };
}

/* ── Fallback resolution ──────────────────────────────────────────────── */

export interface ResolvedAckTemplate {
  template: EnquiryAckTemplate;
  source: "stored" | "default";
}

/**
 * Choose the template to use for an enquiry type.
 *
 *   stored JSON valid & passes validation → use it   (source: "stored")
 *   missing / empty / corrupt / invalid    → default  (source: "default")
 *
 * Per-field emptiness is covered by validation (an empty subject or body is
 * invalid), so a damaged record can never yield an empty email.
 */
export function resolveAckTemplate(
  type: EnquiryType,
  storedJson: string | null | undefined
): ResolvedAckTemplate {
  const fallback: ResolvedAckTemplate = {
    template: ENQUIRY_ACK_DEFAULTS[type],
    source: "default",
  };

  if (typeof storedJson !== "string" || !storedJson.trim()) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(storedJson);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }

  const candidate = parsed as { subject?: unknown; body?: unknown };
  const validated = validateAckTemplate(type, {
    subject: candidate.subject,
    body: candidate.body,
  });
  if (!validated.ok) return fallback;

  return { template: validated.value, source: "stored" };
}

/* ── Safe rendering ───────────────────────────────────────────────────── */

/**
 * Replace allowed `{{name}}` placeholders by plain string substitution.
 *
 * - Only names in `allowed` are substituted, and only when a value exists
 *   (a missing value renders as an empty string — schema fields default to
 *   "" anyway).
 * - Unknown placeholders are returned LITERAL — never executed, never
 *   evaluated. No eval, no Function(), no template compilation.
 */
export function renderAckPlaceholders(
  text: string,
  values: Record<string, string | undefined>,
  allowed: readonly string[]
): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (match, raw: string) => {
    const name = raw.trim();
    if (!allowed.includes(name)) return match;
    return values[name] ?? "";
  });
}

/** Collapse a rendered subject to one line (no header injection). */
function subjectLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the final acknowledgement content for one enquiry.
 *
 * Returns the sanitised subject, the plain-text body and a minimal HTML
 * rendering of that same text (every character — template and substituted
 * values alike — is HTML-escaped first, so the body can never inject markup).
 */
export function renderAcknowledgement(
  type: EnquiryType,
  template: EnquiryAckTemplate,
  values: Record<string, string | undefined>
): { subject: string; text: string; html: string } {
  const allowed = ENQUIRY_ACK_PLACEHOLDERS[type];

  const subject = subjectLine(
    renderAckPlaceholders(template.subject, values, allowed)
  );
  const text = renderAckPlaceholders(template.body, values, allowed).replace(
    /\r\n/g,
    "\n"
  );

  const paragraphs = text
    .split("\n")
    .map((line) =>
      line
        ? `<p style="margin:0 0 10px;line-height:1.6;">${escapeHtml(line)}</p>`
        : `<p style="margin:0 0 10px;line-height:1.6;">&nbsp;</p>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#fff7ea;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #efe3d0;border-radius:14px;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#001524;">
    <p style="margin:0 0 16px;font-size:17px;font-weight:700;color:#001524;">${escapeHtml(subject)}</p>
    ${paragraphs}
  </div>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * Map an enquiry document (or any record of schema fields) to the values a
 * template may substitute. Non-string values are stringified; absent values
 * become "" — matching the shared schema's empty-string convention.
 */
export function ackValuesFromEnquiry(
  enquiry: Partial<Record<string, unknown>>
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of new Set([
    ...ENQUIRY_ACK_PLACEHOLDERS.admission,
    ...ENQUIRY_ACK_PLACEHOLDERS.affiliation,
    ...ENQUIRY_ACK_PLACEHOLDERS.general,
  ])) {
    const value = enquiry[name];
    values[name] =
      value === null || value === undefined ? "" : String(value);
  }
  return values;
}
