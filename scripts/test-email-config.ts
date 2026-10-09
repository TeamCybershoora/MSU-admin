/**
 * Offline verification of the SMTP delivery configuration (lib/email/config.ts)
 * and the reusable mailer's unconfigured path (lib/email/provider.ts).
 *
 * Runs entirely offline: it never opens a TCP connection, never connects to
 * MongoDB, and NEVER sends an email. Every value below is a throwaway dummy —
 * no real SMTP host, username, or password is used or printed.
 *
 * Usage: npx tsx scripts/test-email-config.ts
 */

import { resolveEmailConfig } from "@/lib/email/config";
import { sendEmail } from "@/lib/email/provider";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

/** A complete, valid SMTP environment (dummy values only). */
function validEnv(
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    EMAIL_ENABLED: "true",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "587",
    SMTP_USER: "dummy-user@example.test",
    SMTP_PASS: "dummy-app-password",
    EMAIL_FROM: "MSU Enquiries <enquiries@example.test>",
    ...overrides,
  };
}

/* ── Validation ───────────────────────────────────────────────────────── */

section("SMTP configuration validation (never sends)");

check(
  "EMAIL_ENABLED=false disables sending",
  (() => {
    const r = resolveEmailConfig(validEnv({ EMAIL_ENABLED: "false" }));
    return !r.ready && r.reason === "disabled";
  })()
);

check(
  "a missing host is rejected",
  (() => {
    const r = resolveEmailConfig(validEnv({ SMTP_HOST: "" }));
    return !r.ready && r.reason === "missing_host";
  })()
);

check(
  "a missing port is rejected",
  (() => {
    const r = resolveEmailConfig(validEnv({ SMTP_PORT: "" }));
    return !r.ready && r.reason === "missing_port";
  })()
);

check(
  "a non-numeric / out-of-range port is rejected",
  ["abc", "0", "70000"].every((port) => {
    const r = resolveEmailConfig(validEnv({ SMTP_PORT: port }));
    return !r.ready && r.reason === "invalid_port";
  })
);

check(
  "missing username / password are rejected",
  (() => {
    const noUser = resolveEmailConfig(validEnv({ SMTP_USER: "" }));
    const noPass = resolveEmailConfig(validEnv({ SMTP_PASS: "" }));
    return (
      !noUser.ready &&
      noUser.reason === "missing_user" &&
      !noPass.ready &&
      noPass.reason === "missing_pass"
    );
  })()
);

check(
  "a missing or invalid from address is rejected",
  (() => {
    const missing = resolveEmailConfig(validEnv({ EMAIL_FROM: "" }));
    const invalid = resolveEmailConfig(validEnv({ EMAIL_FROM: "not-an-email" }));
    return (
      !missing.ready &&
      missing.reason === "missing_from" &&
      !invalid.ready &&
      invalid.reason === "invalid_from"
    );
  })()
);

check(
  "an invalid reply-to is rejected",
  (() => {
    const r = resolveEmailConfig(validEnv({ EMAIL_REPLY_TO: "nope" }));
    return !r.ready && r.reason === "invalid_reply_to";
  })()
);

section("TLS mode inference");

check(
  "port 587 defaults to STARTTLS (secure: false)",
  (() => {
    const r = resolveEmailConfig(validEnv({ SMTP_PORT: "587" }));
    return r.ready && r.config.secure === false;
  })()
);

check(
  "port 465 defaults to implicit TLS (secure: true)",
  (() => {
    const r = resolveEmailConfig(validEnv({ SMTP_PORT: "465" }));
    return r.ready && r.config.secure === true;
  })()
);

check(
  "SMTP_SECURE overrides the port default",
  (() => {
    const r = resolveEmailConfig(
      validEnv({ SMTP_PORT: "587", SMTP_SECURE: "true" })
    );
    return r.ready && r.config.secure === true;
  })()
);

check(
  "a fully valid environment resolves, extracting the bare from address",
  (() => {
    const r = resolveEmailConfig(validEnv());
    return r.ready && r.config.from === "MSU Enquiries <enquiries@example.test>";
  })()
);

check(
  "reply-to defaults to null when unset",
  (() => {
    const r = resolveEmailConfig(validEnv());
    return r.ready && r.config.replyTo === null;
  })()
);

/* ── Safe send fallback ───────────────────────────────────────────────── */

async function safeSendFallback() {
  section("Unconfigured mailer fails safe (no throw, no send)");

  const saved = { ...process.env };
  try {
    // Disable outbound email so no connection is ever attempted.
    process.env.EMAIL_ENABLED = "false";

    let threw = false;
    let result: Awaited<ReturnType<typeof sendEmail>> | null = null;
    try {
      result = await sendEmail({
        to: "recipient@example.test",
        subject: "Offline check",
        text: "This must never leave the machine.",
      });
    } catch {
      threw = true;
    }

    check("sendEmail never throws when unconfigured", !threw);
    check(
      "sendEmail reports sent: false with the disabled reason",
      !!result && result.sent === false && result.reason === "disabled"
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

async function main() {
  await safeSendFallback();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log("All email configuration checks passed.");
  }
}

void main();
