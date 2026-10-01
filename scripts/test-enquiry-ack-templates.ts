/**
 * Offline verification of the admin-editable acknowledgement templates
 * (lib/email/enquiry-ack.ts), the template API's authorization guard, and
 * the invariants of the EXISTING email systems (admin reply + SMTP delivery
 * configuration handling).
 *
 * Runs entirely offline: it never connects to MongoDB and never sends an
 * email. The authorization checks invoke the route handlers with
 * unauthenticated requests only — the guard rejects them before any database
 * access, so no configuration can be read or written by these tests.
 *
 * Usage: npx tsx scripts/test-enquiry-ack-templates.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACK_BODY_MAX_LENGTH,
  ACK_SUBJECT_MAX_LENGTH,
  ENQUIRY_ACK_CONFIG_KEYS,
  ENQUIRY_ACK_DEFAULTS,
  ENQUIRY_ACK_PLACEHOLDERS,
  ENQUIRY_ACK_SAMPLE_VALUES,
  formatAckPlaceholder,
  renderAckPlaceholders,
  renderAcknowledgement,
  resolveAckTemplate,
  validateAckTemplate,
} from "@/lib/email/enquiry-ack";
import { ENQUIRY_TYPES } from "@/lib/enquiry-types";
import { buildEnquiryReplyEmail } from "@/lib/email/templates";

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

/** JSON a fully customised template for a type would be stored as. */
function storedJson(subject: string, body: string): string {
  return JSON.stringify({ subject, body });
}

/* ── Storage contract + defaults ─────────────────────────────── */

section("Storage contract and built-in defaults");

check(
  "SiteConfig keys are enquiry_ack_admission / enquiry_ack_affiliation",
  ENQUIRY_ACK_CONFIG_KEYS.admission === "enquiry_ack_admission" &&
    ENQUIRY_ACK_CONFIG_KEYS.affiliation === "enquiry_ack_affiliation"
);
check(
  "the two types have distinct defaults",
  ENQUIRY_ACK_DEFAULTS.admission.body !== ENQUIRY_ACK_DEFAULTS.affiliation.body
);
check(
  "every default validates for its own type",
  ENQUIRY_TYPES.every(
    (type) => validateAckTemplate(type, ENQUIRY_ACK_DEFAULTS[type]).ok
  )
);
check(
  "every default subject is non-empty after render",
  ENQUIRY_TYPES.every((type) => {
    const r = renderAcknowledgement(
      type,
      ENQUIRY_ACK_DEFAULTS[type],
      ENQUIRY_ACK_SAMPLE_VALUES[type]
    );
    return r.subject.length > 0 && r.text.length > 0;
  })
);
check(
  "sample values cover every allowed placeholder of their type",
  ENQUIRY_TYPES.every((type) =>
    ENQUIRY_ACK_PLACEHOLDERS[type].every(
      (name) => ENQUIRY_ACK_SAMPLE_VALUES[type][name] !== undefined
    )
  )
);
check(
  "admission and affiliation expose different placeholder sets",
  ENQUIRY_ACK_PLACEHOLDERS.admission.includes("fullName") &&
    !ENQUIRY_ACK_PLACEHOLDERS.affiliation.includes("fullName") &&
    ENQUIRY_ACK_PLACEHOLDERS.affiliation.includes("contactPerson") &&
    !ENQUIRY_ACK_PLACEHOLDERS.admission.includes("contactPerson")
);

/* ── Template loading ────────────────────────────────────────── */

section("Stored template loading (admission + affiliation)");

const customAdmission = storedJson(
  "Custom admission subject",
  "Dear {{fullName}}, your admission enquiry {{reference}} was received."
);
const customAffiliation = storedJson(
  "Custom college subject",
  "Dear {{contactPerson}}, your registration enquiry from {{collegeName}} was received."
);

check(
  "a stored admission template is used (source: stored)",
  (() => {
    const r = resolveAckTemplate("admission", customAdmission);
    return (
      r.source === "stored" &&
      r.template.subject === "Custom admission subject" &&
      r.template.body.includes("{{reference}}")
    );
  })()
);
check(
  "a stored affiliation template is used (source: stored)",
  (() => {
    const r = resolveAckTemplate("affiliation", customAffiliation);
    return (
      r.source === "stored" &&
      r.template.subject === "Custom college subject" &&
      r.template.body.includes("{{collegeName}}")
    );
  })()
);
check(
  "a stored template is trimmed on resolve",
  resolveAckTemplate("admission", storedJson("  Padded subject  ", "  Padded body  "))
    .template.subject === "Padded subject"
);

/* ── Default fallback ────────────────────────────────────────── */

section("Default fallback (empty or corrupt config never yields an empty email)");

const brokenInputs: Array<[string, string | null | undefined]> = [
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["whitespace only", "   "],
  ["not JSON", "Dear {{fullName}}, hello"],
  ["JSON array", "[1,2,3]"],
  ["JSON string", '"hello"'],
  ["empty object", "{}"],
  ["subject missing", JSON.stringify({ body: "Some body text here" })],
  ["body missing", JSON.stringify({ subject: "Some subject" })],
  ["subject empty", storedJson("", "Valid body text here")],
  ["body empty", storedJson("Valid subject", "")],
  [
    "unknown placeholder stored",
    storedJson("Hi", "Dear {{hacker}}, please run {{constructor}}"),
  ],
  ["wrong value types", JSON.stringify({ subject: 42, body: true })],
];

for (const [label, input] of brokenInputs) {
  for (const type of ENQUIRY_TYPES) {
    const r = resolveAckTemplate(type, input);
    check(
      `${type}: ${label} falls back to the default`,
      r.source === "default" &&
        r.template.subject.trim().length > 0 &&
        r.template.body.trim().length > 0 &&
        r.template.subject === ENQUIRY_ACK_DEFAULTS[type].subject
    );
  }
}

/* ── Placeholder replacement ─────────────────────────────────── */

section("Placeholder replacement (controlled, no execution)");

check(
  "allowed placeholders are substituted",
  renderAckPlaceholders(
    "Dear {{fullName}}, ref {{reference}}.",
    { fullName: "Asha Kumar", reference: "MSU-ENQ-48J7PRKQ" },
    ENQUIRY_ACK_PLACEHOLDERS.admission
  ) === "Dear Asha Kumar, ref MSU-ENQ-48J7PRKQ."
);
check(
  "whitespace inside braces is tolerated",
  renderAckPlaceholders(
    "Ref: {{ reference }}",
    { reference: "MSU-ENQ-48J7PRKQ" },
    ENQUIRY_ACK_PLACEHOLDERS.admission
  ) === "Ref: MSU-ENQ-48J7PRKQ"
);
check(
  "an allowed but missing value renders empty (schema default)",
  renderAckPlaceholders(
    "Course: {{course}}.",
    {},
    ENQUIRY_ACK_PLACEHOLDERS.admission
  ) === "Course: ."
);
check(
  "an unknown placeholder stays LITERAL (never executed)",
  renderAckPlaceholders(
    "Hi {{fullName}}, try {{eval(1)}} and {{constructor}}.",
    { fullName: "Asha" },
    ENQUIRY_ACK_PLACEHOLDERS.admission
  ) === "Hi Asha, try {{eval(1)}} and {{constructor}}."
);
check(
  "a placeholder from the other type is not substituted",
  renderAckPlaceholders(
    "Org: {{collegeName}}.",
    { collegeName: "MSU College" },
    ENQUIRY_ACK_PLACEHOLDERS.admission
  ) === "Org: {{collegeName}}."
);

section("Rendering safety");

check(
  "a newline in a value cannot break the subject line",
  (() => {
    const r = renderAcknowledgement(
      "admission",
      { subject: "About {{fullName}}", body: "Body" },
      { fullName: "Line1\nBcc: victim@example.com" }
    );
    return !/[\r\n]/.test(r.subject) && r.subject.includes("Line1 Bcc:");
  })()
);
check(
  "HTML in a value is escaped in the HTML rendering",
  (() => {
    const r = renderAcknowledgement(
      "admission",
      { subject: "S", body: "{{fullName}}" },
      { fullName: "<script>alert(1)</script>" }
    );
    return (
      !r.html.includes("<script>") && r.html.includes("&lt;script&gt;")
    );
  })()
);
check(
  "the plain-text rendering keeps the raw value readable",
  renderAcknowledgement(
    "admission",
    { subject: "S", body: "Name: {{fullName}}" },
    { fullName: "Asha <ash@x.com>" }
  ).text === "Name: Asha <ash@x.com>"
);
check(
  "the HTML rendering marks the body up as plain text (newlines preserved)",
  (() => {
    const r = renderAcknowledgement(
      "admission",
      { subject: "S", body: "Line one\nLine two" },
      {}
    );
    return r.html.includes("<br") === false && r.html.includes("Line two");
  })()
);

/* ── Save validation ─────────────────────────────────────────── */

section("Server-side template validation");

check(
  "a valid admission template is accepted",
  (() => {
    const r = validateAckTemplate("admission", {
      subject: "Thank you for contacting MSU",
      body: "Dear {{fullName}}, we received your enquiry {{reference}}.",
    });
    return r.ok && r.value.subject.startsWith("Thank you");
  })()
);
check(
  "a valid affiliation template is accepted",
  validateAckTemplate("affiliation", {
    subject: "Thank you",
    body: "Dear {{contactPerson}} of {{collegeName}}, received.",
  }).ok
);
check(
  "an unknown enquiry type is rejected",
  !validateAckTemplate("contact", { subject: "S", body: "B" }).ok &&
    !validateAckTemplate(undefined, { subject: "S", body: "B" }).ok
);
check(
  "a non-object template is rejected",
  !validateAckTemplate("admission", null).ok &&
    !validateAckTemplate("admission", "text").ok &&
    !validateAckTemplate("admission", []).ok
);
check(
  "an empty subject is rejected",
  !validateAckTemplate("admission", { subject: "   ", body: "Body" }).ok
);
check(
  "an empty body is rejected (never an empty email)",
  !validateAckTemplate("admission", { subject: "Subject", body: "  " }).ok
);
check(
  "a multi-line subject is rejected (header-injection guard)",
  !validateAckTemplate("admission", {
    subject: "Hello\nBcc: victim@example.com",
    body: "Body",
  }).ok
);
check(
  `a subject over ${ACK_SUBJECT_MAX_LENGTH} chars is rejected`,
  !validateAckTemplate("admission", {
    subject: "a".repeat(ACK_SUBJECT_MAX_LENGTH + 1),
    body: "Body",
  }).ok
);
check(
  `a body over ${ACK_BODY_MAX_LENGTH} chars is rejected`,
  !validateAckTemplate("admission", {
    subject: "Subject",
    body: "a".repeat(ACK_BODY_MAX_LENGTH + 1),
  }).ok
);
check(
  "an unknown placeholder is rejected with the allowed list",
  (() => {
    const r = validateAckTemplate("admission", {
      subject: "Hi",
      body: "Dear {{nickname}}, ref {{reference}}",
    });
    return !r.ok && r.message.includes("{{nickname}}") && r.message.includes("{{reference}}");
  })()
);
check(
  "affiliation-only placeholders are rejected for admission templates",
  !validateAckTemplate("admission", {
    subject: "Hi",
    body: "Dear {{contactPerson}}",
  }).ok
);
check(
  "admission-only placeholders are rejected for affiliation templates",
  !validateAckTemplate("affiliation", {
    subject: "Hi",
    body: "Dear {{fullName}}",
  }).ok
);
check(
  "placeholder formatting helper wraps names in braces",
  formatAckPlaceholder("reference") === "{{reference}}"
);

/* ── Authorization (route guards, no database touched) ───────── */

const noAuthGet = new Request(
  "http://localhost/api/admin/enquiry-email-templates"
);
const noAuthPut = new Request(
  "http://localhost/api/admin/enquiry-email-templates",
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "admission",
      subject: "Injected subject",
      body: "Injected body",
    }),
  }
);
const noAuthDelete = new Request(
  "http://localhost/api/admin/enquiry-email-templates?type=admission",
  { method: "DELETE" }
);
const badTokenPut = new Request(
  "http://localhost/api/admin/enquiry-email-templates",
  {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer not-a-real-token",
    },
    body: JSON.stringify({
      type: "admission",
      subject: "Injected subject",
      body: "Injected body",
    }),
  }
);

async function authorizationChecks() {
  section("Template API requires authentication on every verb");

  // The route chain reads JWT_SECRET at module scope (lib/auth-helpers.ts),
  // so the module is imported dynamically AFTER a value exists. A fixed
  // dummy is used unless one is already set: no .env file is read and no
  // secret is ever printed — any value lets unauthenticated requests REACH
  // the guard, which is exactly what these checks exercise.
  process.env.JWT_SECRET ??=
    "offline-ack-template-test-secret-0123456789abcdef";

  const { GET, PUT, DELETE } = await import(
    "@/app/api/admin/enquiry-email-templates/route"
  );

  check("GET without a token → 401", (await GET(noAuthGet)).status === 401);
  check(
    "PUT without a token → 401 (nothing written)",
    (await PUT(noAuthPut)).status === 401
  );
  check(
    "DELETE without a token → 401 (nothing deleted)",
    (await DELETE(noAuthDelete)).status === 401
  );
  check(
    "PUT with a garbage bearer token → 401",
    (await PUT(badTokenPut)).status === 401
  );
}

/* ── Existing systems remain intact ──────────────────────────── */

section("Existing admin reply system is untouched and still builds");

check(
  "buildEnquiryReplyEmail still produces subject, html and text",
  (() => {
    const reply = buildEnquiryReplyEmail({
      reference: "MSU-ENQ-48J7PRKQ",
      type: "admission",
      adminName: "Admin",
      message: "Thanks for your enquiry — we will call you shortly.",
      repliedAt: new Date(),
    });
    return (
      reply.subject.includes("MSU-ENQ-48J7PRKQ") &&
      reply.html.length > 0 &&
      reply.text.includes("Thanks for your enquiry")
    );
  })()
);
check(
  "the reply email still escapes the admin message",
  (() => {
    const reply = buildEnquiryReplyEmail({
      reference: "MSU-ENQ-48J7PRKQ",
      type: "affiliation",
      adminName: "Admin",
      message: "<script>alert(1)</script>",
      repliedAt: new Date(),
    });
    return !reply.html.includes("<script>alert(1)");
  })()
);

section("SMTP delivery config stays server-side and recipient-free");

const providerSource = readFileSync(
  path.join(process.cwd(), "lib", "email", "provider.ts"),
  "utf8"
);
const emailConfigSource = readFileSync(
  path.join(process.cwd(), "lib", "email", "config.ts"),
  "utf8"
);
check(
  "the reply recipient is always the enquiry's own stored address",
  providerSource.includes("to: input.to")
);
check(
  "the provider sends through SMTP (nodemailer), not Resend",
  providerSource.includes("nodemailer") && !/from \"resend\"/.test(providerSource)
);
check(
  "no test/preview recipient override exists in the provider or config",
  !/testRecipient|previewRecipient|debugRecipient|TEST_RECIPIENT/i.test(
    providerSource + emailConfigSource
  )
);
check(
  "the email config exposes delivery settings only, never a recipient override",
  emailConfigSource.includes("EMAIL_FROM") &&
    !/RECIPIENT/i.test(
      emailConfigSource.split("EMAIL_NOTIFICATION_RECIPIENT (used by the public")[0]
    )
);

/* ── Run async checks, then summarize ───────────────────────── */

async function main() {
  try {
    await authorizationChecks();
  } catch (error) {
    failed += 1;
    console.error("  FAIL  authorization checks threw an unexpected error:", error);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log("All enquiry acknowledgement template checks passed.");
  }
}

void main();
