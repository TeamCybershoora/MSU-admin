/**
 * Server-side email template for ADMIN REPLIES to an enquiry submitter.
 *
 * Design rules:
 *   - Simple table-based HTML with inline styles — works in normal email
 *     clients. No JavaScript, no external images/CSS.
 *   - EVERY user- or admin-supplied value is HTML-escaped before it reaches the
 *     HTML body, and stripped of CR/LF before it reaches a subject line, so
 *     neither a submitter's enquiry data nor an admin's reply text can inject
 *     markup or email headers.
 *   - A plain-text alternative is generated alongside the HTML.
 *   - Visual identity follows the MSU palette (cream #ffecd1, navy #001524,
 *     teal #15616d, ember #e07a52) and the public enquiry emails.
 *
 * PUBLIC CONTENT: the university contact details below are the real public MSU
 * contact information shown on the website. Displaying them in an email footer
 * is content — it is NOT delivery configuration. Where the email is actually
 * sent from is decided solely by lib/email/config.ts (environment variables).
 */

import type { EnquiryType } from "@/lib/enquiry-types";

/** Everything the reply template needs about one reply. */
export interface EnquiryReplyEmailData {
  /** Server-known reference of the enquiry being answered, e.g. MSU-ENQ-48J7PRKQ. */
  reference: string;
  /** Enquiry type, used only for a human-readable heading. */
  type: EnquiryType;
  /** Name of the administrator who wrote the reply (display only). */
  adminName: string;
  /** The administrator's reply text. User-controlled — always escaped. */
  message: string;
  /** When the reply was sent. */
  repliedAt: Date;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/* ── Public university information (public content) ─────────────────── */

const UNIVERSITY_NAME = "Maa Shakumbhari University";

const UNIVERSITY_CONTACT = {
  addressLines: [
    "Village Punwarka, District Saharanpur",
    "Uttar Pradesh — 247001",
  ],
  emails: ["info@msu.ac.in", "exam@msu.ac.in"],
  phone: "+91 96513 61171",
  hours: "Monday – Saturday, 10:00 AM – 5:00 PM",
};

/* ── Brand palette ───────────────────────────────────────────────────── */

const CREAM = "#ffecd1";
const CREAM_SOFT = "#fff7ea";
const NAVY = "#001524";
const TEAL = "#15616d";
const ORANGE = "#ff7d00";
const MUTED = "#4a4a4a";
const BORDER = "#efe3d0";

/* ── Small helpers ───────────────────────────────────────────────────── */

/** Escape a user-controlled value for safe interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Collapse a value to a single line for a subject line.
 * Control characters (including CR/LF) are replaced, so a value can never
 * inject an extra email header.
 */
function singleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Multi-line-safe escaped text (message bodies). */
function escapedWithBreaks(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br />");
}

/** Localised timestamp (Indian time), e.g. "25 Sep 2026, 7:42 pm IST". */
function formatTimestamp(date: Date): string {
  return `${date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  })} IST`;
}

/** Human-readable label for the enquiry type. */
function typeLabel(type: EnquiryType): string {
  switch (type) {
    case "affiliation":
      return "college registration / affiliation";
    case "general":
      return "general";
    default:
      return "admission";
  }
}

/** Reference callout, mirrored from the public enquiry emails. */
function referenceBox(reference: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;">
    <tr>
      <td style="background:${CREAM};border:1px solid ${BORDER};border-radius:10px;padding:12px 16px;">
        <p style="margin:0;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">Your enquiry reference</p>
        <p style="margin:4px 0 0;font-family:Courier,monospace;font-size:16px;font-weight:700;color:${NAVY};">${escapeHtml(reference)}</p>
      </td>
    </tr>
  </table>`;
}

/** Public contact block used in the footer. */
function contactBlock(): string {
  const address = UNIVERSITY_CONTACT.addressLines
    .map((line) => escapeHtml(line))
    .join("<br />");
  const emails = UNIVERSITY_CONTACT.emails
    .map((email) => escapeHtml(email))
    .join(" · ");

  return `<p style="margin:0 0 6px;font-size:13px;color:${NAVY};font-weight:600;">${escapeHtml(UNIVERSITY_NAME)}</p>
    <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${MUTED};">${address}</p>
    <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${MUTED};">${emails}</p>
    <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">${escapeHtml(UNIVERSITY_CONTACT.phone)} · ${escapeHtml(UNIVERSITY_CONTACT.hours)}</p>`;
}

/** Shared HTML shell. */
function layout(options: {
  title: string;
  kicker: string;
  heading: string;
  introHtml: string;
  bodyHtml: string;
  footerHtml: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(options.title)}</title>
</head>
<body style="margin:0;padding:0;background:${CREAM_SOFT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM_SOFT};">
    <tr>
      <td align="center" style="padding:28px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
          <tr>
            <td style="background:${NAVY};padding:18px 24px;">
              <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${ORANGE};">${escapeHtml(options.kicker)}</p>
              <p style="margin:6px 0 0;font-size:17px;font-weight:700;color:#ffffff;">${escapeHtml(UNIVERSITY_NAME)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <h1 style="margin:0 0 12px;font-size:19px;line-height:1.35;color:${NAVY};">${escapeHtml(options.heading)}</h1>
              <p style="margin:0;font-size:14px;line-height:1.65;color:${MUTED};">${options.introHtml}</p>
              ${options.bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background:${CREAM};padding:18px 24px;border-top:1px solid ${BORDER};">
              ${options.footerHtml}
            </td>
          </tr>
        </table>
        <p style="margin:14px 0 0;font-size:11px;line-height:1.6;color:${MUTED};max-width:600px;">
          This message was sent in response to an enquiry submitted through the ${escapeHtml(UNIVERSITY_NAME)} website. Please quote the reference above in any future correspondence.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Shared plain-text body. */
function plainText(options: {
  heading: string;
  intro: string;
  reference: string;
  reply: string;
  signature: string;
}): string {
  return [
    options.heading,
    "",
    options.intro,
    "",
    `Your enquiry reference: ${options.reference}`,
    "",
    "Reply:",
    options.reply,
    "",
    options.signature,
    "",
    `${UNIVERSITY_NAME}`,
    ...UNIVERSITY_CONTACT.addressLines,
    UNIVERSITY_CONTACT.emails.join(" · "),
    `${UNIVERSITY_CONTACT.phone} · ${UNIVERSITY_CONTACT.hours}`,
  ].join("\n");
}

/* ── Admin reply email ───────────────────────────────────────────────── */

/**
 * Build the reply email an administrator sends to the submitter.
 *
 * The subject is derived from the reference only (a fixed-format value) and the
 * admin's reply text never reaches the subject line, so no user-controlled
 * content can influence email headers. The reply body is escaped in HTML.
 */
export function buildEnquiryReplyEmail(
  data: EnquiryReplyEmailData
): EmailContent {
  const reference = singleLine(data.reference);
  const subject = singleLine(
    `Re: ${reference} — response to your ${typeLabel(data.type)} enquiry`
  );

  const heading = "Response to your enquiry";

  const intro = `Thank you for contacting ${escapeHtml(UNIVERSITY_NAME)}. You submitted a ${escapeHtml(typeLabel(data.type))} enquiry through our website, and here is our response.`;

  const bodyHtml = `
    ${referenceBox(data.reference)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
      <tr>
        <td style="background:${CREAM_SOFT};border-left:4px solid ${TEAL};border-radius:8px;padding:14px 16px;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">Message</p>
          <p style="margin:0;font-size:14px;line-height:1.7;color:${NAVY};">${escapedWithBreaks(data.message)}</p>
        </td>
      </tr>
    </table>
    <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:${MUTED};">
      Sent on ${escapeHtml(formatTimestamp(data.repliedAt))} by ${escapeHtml(data.adminName)}.
      The reference above identifies the enquiry this reply concerns.
    </p>`;

  const html = layout({
    title: subject,
    kicker: "Enquiry response",
    heading,
    introHtml: intro,
    bodyHtml,
    footerHtml: contactBlock(),
  });

  const text = plainText({
    heading,
    intro: `Thank you for contacting ${UNIVERSITY_NAME}. You submitted a ${typeLabel(data.type)} enquiry through our website, and here is our response.`,
    reference: data.reference,
    reply: data.message,
    signature: `Sent on ${formatTimestamp(data.repliedAt)} by ${data.adminName}. The reference above identifies the enquiry this reply concerns.`,
  });

  return { subject, html, text };
}
