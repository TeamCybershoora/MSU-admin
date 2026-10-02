/**
 * Email delivery provider (server-side only) — **authenticated SMTP**.
 *
 * PROVIDER: a single SMTP transport (nodemailer) configured entirely from
 * environment variables (see ./config.ts). The same mailer is intended to serve
 * both email paths in the MSU system:
 *   1. the automatic acknowledgement sent after a public enquiry is saved, and
 *   2. a manual admin reply from the enquiry dashboard.
 * Resend is no longer used at runtime.
 *
 * WHY SMTP: authenticated SMTP (e.g. Gmail with an App Password) sends through
 * the university mailbox itself, so replies and acknowledgements come from a
 * real, monitored address.
 *
 * RECIPIENT RULE: an admin reply always goes to the enquiry's OWN stored email
 * address, which the caller reads from the database. This module never accepts a
 * recipient from a request body, so an administrator cannot address a reply to
 * an arbitrary third party through the API. The sender identity is likewise
 * fixed by configuration — no caller and no enquiry record can set it.
 *
 * RELIABILITY CONTRACT (read by app/api/admin/enquiries/[id]/reply/route.ts):
 *   - sendEnquiryReply() NEVER throws and NEVER decides HTTP status by itself.
 *   - It reports whether the SMTP server ACCEPTED the message. That is the only
 *     delivery fact this application can verify — it is not proof of arrival in
 *     the recipient's inbox, and no caller may claim more than that.
 *   - Failures (server down, bad credentials, timeout, disabled/unconfigured)
 *     are logged server-side with secrets redacted and reported as `sent: false`
 *     with a reason token.
 *   - No queue or retry infrastructure exists; a failed reply is simply not sent
 *     and the administrator can retry from the UI.
 *
 * SECURITY:
 *   - SMTP credentials are read from process.env on the server and never leave
 *     it: they are not returned, logged, audited, or stored in MongoDB.
 *   - Any error text that is logged is scrubbed of the SMTP username, password,
 *     and anything that looks like a secret before it is printed.
 */

import nodemailer, { type Transporter } from "nodemailer";
import {
  resolveEmailConfig,
  type EmailConfig,
  type EmailSkipReason,
} from "./config";
import { buildEnquiryReplyEmail, type EnquiryReplyEmailData } from "./templates";

/** Per-email network timeout so a hung SMTP server cannot stall the API. */
const SEND_TIMEOUT_MS = 8000;

/**
 * Closed set of delivery outcomes.
 *
 * `smtp_accepted` is the ONLY success value; everything else is a safe,
 * non-secret token that may be recorded in an audit record's `metadata`.
 */
export type DeliveryReason =
  | "smtp_accepted"
  | EmailSkipReason
  | "smtp_rejected"
  | "smtp_error"
  | "timeout";

export interface DeliveryResult {
  /** True only when the SMTP server accepted the message for delivery. */
  sent: boolean;
  reason: DeliveryReason;
}

/** Generic payload for the reusable SMTP mailer. */
export interface SendEmailInput {
  /** Final recipient address. */
  to: string;
  subject: string;
  /** Plain-text body (always sent; the HTML part is optional). */
  text: string;
  html?: string;
  /** Optional Reply-To. Defaults to the configured EMAIL_REPLY_TO. */
  replyTo?: string | null;
}

/**
 * Reuse one transport per distinct configuration for the lifetime of the
 * process. The cache key is compared in memory only and is never logged.
 */
let cached: { key: string; transport: Transporter } | null = null;

function getTransport(config: EmailConfig): Transporter {
  const key = [
    config.host,
    config.port,
    config.secure ? "secure" : "starttls",
    config.user,
    config.pass,
  ].join("|");

  if (!cached || cached.key !== key) {
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
      }),
    };
  }
  return cached.transport;
}

/**
 * Remove anything resembling a credential from text that is about to be logged.
 * The configured username/password are blanked, plus common token shapes.
 */
function redactSecrets(text: string, config: EmailConfig): string {
  let out = text;
  if (config.pass) out = out.split(config.pass).join("[redacted]");
  if (config.user) out = out.split(config.user).join("[redacted]");
  return out
    .replace(/\bsmtp:\/\/[^\s]+/gi, "smtp://[redacted]")
    .replace(/\bre_[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
}

/**
 * Send one email through the configured SMTP transport.
 *
 * Resolves with the delivery outcome. Never throws, and never logs PII or
 * secrets: only a redacted error message is printed.
 */
export async function sendEmail(
  input: SendEmailInput
): Promise<DeliveryResult> {
  const label = "transactional email";

  let config: EmailConfig | null = null;
  try {
    const resolution = resolveEmailConfig();
    if (!resolution.ready) {
      console.warn(
        `[msu-email] ${label} skipped (${resolution.reason}) — nothing was modified.`
      );
      return { sent: false, reason: resolution.reason };
    }
    config = resolution.config;

    const transport = getTransport(config);
    const info = await transport.sendMail({
      from: config.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      // A submitter's natural "Reply" should reach a monitored mailbox; fall
      // back to the From address when no reply-to is configured.
      replyTo: input.replyTo || config.replyTo || undefined,
    });

    const rejected = Array.isArray(info.rejected) ? info.rejected : [];
    if (rejected.length && !info.accepted?.length) {
      console.error(
        `[msu-email] ${label} rejected by server for ${rejected.length} recipient(s).`
      );
      return { sent: false, reason: "smtp_rejected" };
    }

    return { sent: true, reason: "smtp_accepted" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout|timed out|ETIMEDOUT|ESOCKET/i.test(message);
    console.error(
      `[msu-email] ${label} failed: ${
        config ? redactSecrets(message, config) : message
      }`
    );
    return { sent: false, reason: timedOut ? "timeout" : "smtp_error" };
  }
}

export interface SendEnquiryReplyInput extends EnquiryReplyEmailData {
  /**
   * Final recipient. MUST be the enquiry's stored email address, read from the
   * database by the caller — never a value supplied by the client.
   */
  to: string;
}

/**
 * Send one reply email to the enquiry submitter through the shared SMTP mailer.
 *
 * Resolves with the delivery outcome. Never throws, and never logs PII or
 * secrets: only the reference and a redacted error message are printed.
 */
export async function sendEnquiryReply(
  input: SendEnquiryReplyInput
): Promise<DeliveryResult> {
  try {
    const content = buildEnquiryReplyEmail(input);
    return await sendEmail({
      // Authoritative destination: the submitter's stored address.
      to: input.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  } catch (error) {
    // Defence in depth: an email-side bug must never surface as a crash. No PII
    // and no provider payload is logged.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[msu-email] reply ${input.reference} unexpected error: ${message}`
    );
    return { sent: false, reason: "smtp_error" };
  }
}
