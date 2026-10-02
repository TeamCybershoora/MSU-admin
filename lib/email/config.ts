/**
 * Server-side EMAIL DELIVERY configuration (SMTP).
 *
 * ────────────────────────────────────────────────────────────────────────
 *  TWO SEPARATE CONCEPTS — keep them apart:
 *
 *  1. PUBLIC UNIVERSITY INFORMATION  (public content)
 *     The real MSU contact details shown on the website and in email footers
 *     live in lib/email/templates.ts. They are displayed to people and are
 *     NEVER used as delivery targets here.
 *
 *  2. EMAIL DELIVERY CONFIGURATION   (infrastructure secrets)
 *     Where email is ACTUALLY sent from — configured only through the
 *     environment variables below, read server-side only, never returned to
 *     the browser, never stored in MongoDB, and never shown in any admin UI.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Environment variable NAMES consumed here (values are never read, printed or
 * logged by this module):
 *
 *   SMTP_HOST                SMTP server hostname (e.g. smtp.gmail.com).
 *   SMTP_PORT                SMTP port (e.g. 587 for STARTTLS, 465 for TLS).
 *   SMTP_SECURE              Optional "true"/"1" to force implicit TLS. When
 *                            unset, TLS is inferred from the port (465 → on).
 *   SMTP_USER                Authenticated SMTP username (for Gmail: the full
 *                            address, e.g. enquiries@your-domain).
 *   SMTP_PASS                SMTP app password / credential. SERVER ONLY.
 *   EMAIL_FROM               Sender address, e.g. "MSU Enquiries
 *                            <enquiries@your-domain>" or bare
 *                            "enquiries@your-domain".
 *   EMAIL_REPLY_TO           Where replies from the submitter should go (a
 *                            monitored mailbox). Optional — when unset, replies
 *                            fall back to the From address.
 *   EMAIL_ENABLED            Set to "false" / "0" / "no" / "off" to disable all
 *                            outbound email. Unset = enabled.
 *
 * These names deliberately MATCH the public MSU email implementation, so one
 * environment configuration serves both applications.
 *
 * EMAIL_NOTIFICATION_RECIPIENT (used by the public site to deliver its
 * new-enquiry notifications) is intentionally NOT required here: an admin reply
 * always goes to the submitter's own stored address, never to a configured
 * mailbox.
 *
 * This module is imported by server code only (API routes / lib/email/*). The
 * client can never influence any of these values.
 */

import { isValidEmail } from "@/lib/validation";

/** Documentation-only list of the variable names this module consumes. */
export const EMAIL_ENV_VAR_NAMES = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "EMAIL_ENABLED",
] as const;

/**
 * Also part of the shared email configuration, but owned by the PUBLIC site's
 * notification emails — not required for an admin reply.
 */
export const PUBLIC_EMAIL_ENV_VAR_NAMES = [
  "EMAIL_NOTIFICATION_RECIPIENT",
] as const;

/** Resolved, validated SMTP delivery configuration (server-side only). */
export interface EmailConfig {
  /** SMTP server hostname. */
  host: string;
  /** SMTP server port. */
  port: number;
  /** True for implicit TLS (port 465); false for STARTTLS/plain. */
  secure: boolean;
  /** Authenticated SMTP username. */
  user: string;
  /** SMTP password — NEVER logged, NEVER returned to the client. */
  pass: string;
  /** Trusted sender, e.g. `"Maa Shakumbhari University <enquiries@x>"`. */
  from: string;
  /** Fallback reply-to for outbound mail (optional). */
  replyTo: string | null;
}

/**
 * Why an email was not sent. These tokens are safe for internal logs and for an
 * audit record's `metadata`, and are never revealed to the public client.
 */
export type EmailSkipReason =
  | "disabled"
  | "missing_host"
  | "missing_port"
  | "invalid_port"
  | "missing_user"
  | "missing_pass"
  | "missing_from"
  | "invalid_from"
  | "invalid_reply_to";

export type EmailConfigResolution =
  | { ready: true; config: EmailConfig }
  | { ready: false; reason: EmailSkipReason };

/**
 * Extract the bare address from `"Name <a@b.c>"` or return the value itself.
 * Returns null when the address part is not a valid email address. Whitespace
 * (including CR/LF) is rejected by isValidEmail, so a malformed header can never
 * be smuggled through here.
 */
function extractAddress(value: string): string | null {
  const trimmed = value.trim();
  const angled = /^(.*)<([^<>]+)>$/.exec(trimmed);
  const address = (angled ? angled[2] : trimmed).trim();
  return isValidEmail(address) ? address : null;
}

/** True unless EMAIL_ENABLED explicitly asks for a falsy value. */
function isEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return (
    value !== "false" && value !== "0" && value !== "no" && value !== "off"
  );
}

/** Explicit SMTP_SECURE flag, defaulting to implicit TLS on port 465. */
function resolveSecure(raw: string | undefined, port: number): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return port === 465;
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

/**
 * Resolve the SMTP delivery configuration from the environment.
 *
 * Returns `{ ready: false, reason }` when sending is impossible — the caller
 * must then SKIP sending (never throw, never fail the request) and may record
 * the reason token. Nothing here ever exposes a value, only a reason code.
 */
export function resolveEmailConfig(
  env: NodeJS.ProcessEnv = process.env
): EmailConfigResolution {
  if (!isEnabled(env.EMAIL_ENABLED)) {
    return { ready: false, reason: "disabled" };
  }

  const host = (env.SMTP_HOST ?? "").trim();
  if (!host) return { ready: false, reason: "missing_host" };

  const rawPort = (env.SMTP_PORT ?? "").trim();
  if (!rawPort) return { ready: false, reason: "missing_port" };
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ready: false, reason: "invalid_port" };
  }

  const user = (env.SMTP_USER ?? "").trim();
  if (!user) return { ready: false, reason: "missing_user" };

  const pass = (env.SMTP_PASS ?? "").trim();
  if (!pass) return { ready: false, reason: "missing_pass" };

  const rawFrom = (env.EMAIL_FROM ?? "").trim();
  if (!rawFrom) return { ready: false, reason: "missing_from" };
  if (!extractAddress(rawFrom)) return { ready: false, reason: "invalid_from" };

  const rawReplyTo = (env.EMAIL_REPLY_TO ?? "").trim();
  let replyTo: string | null = null;
  if (rawReplyTo) {
    replyTo = extractAddress(rawReplyTo);
    if (!replyTo) return { ready: false, reason: "invalid_reply_to" };
  }

  return {
    ready: true,
    config: {
      host,
      port,
      secure: resolveSecure(env.SMTP_SECURE, port),
      user,
      pass,
      from: rawFrom,
      replyTo,
    },
  };
}
