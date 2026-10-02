/**
 * Enquiry Email Templates API — admin-manageable automatic acknowledgement
 * content for each enquiry type (admission, affiliation, general).
 *
 * Endpoints (all require an active admin JWT; rate limited 60 / 15 min):
 *   GET    /api/admin/enquiry-email-templates
 *          → every template (with `source`: "stored" | "default"), the
 *            built-in defaults, and the allowed placeholder lists
 *   PUT    /api/admin/enquiry-email-templates
 *          body: { type, subject, body } — server-side validated, then stored
 *            as JSON in the existing SiteConfig collection (keys
 *            enquiry_ack_admission / enquiry_ack_affiliation /
 *            enquiry_ack_general)
 *   DELETE /api/admin/enquiry-email-templates?type=<type>
 *          → removes the stored override; the built-in default takes over
 *
 * SECURITY:
 * - authenticateAdmin() on EVERY verb (same guard as the rest of the admin
 *   API) — a public enquiry submitter can never reach this endpoint.
 * - Template content is validated server-side by validateAckTemplate()
 *   (shape, length, single-line subject, per-type placeholder whitelist);
 *   the client's validation is convenience only.
 * - No email is ever sent by this route — it only stores content. The
 *   recipient logic of the email system is untouched here.
 * - Read responses carry ONLY template content (no secrets; delivery config
 *   stays in environment variables and is never returned by any endpoint).
 *
 * STORAGE: the existing SiteConfig key-value collection — no new collection,
 * no schema change, no modification of enquiry records.
 */

import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import SiteConfig from "@/models/SiteConfig";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { isEnquiryType, ENQUIRY_TYPES } from "@/lib/enquiry-types";
import {
  ENQUIRY_ACK_CONFIG_KEYS,
  ENQUIRY_ACK_DEFAULTS,
  ENQUIRY_ACK_PLACEHOLDERS,
  resolveAckTemplate,
  validateAckTemplate,
} from "@/lib/email/enquiry-ack";

const ackTemplateLimiter = createRateLimiter({
  name: "admin-enquiry-ack-templates",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

function rateLimited() {
  return NextResponse.json(
    { success: false, message: "Too many requests. Please try again later." },
    { status: 429 }
  );
}

/* ── GET — current templates + defaults + placeholders ────────────────── */

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (ackTemplateLimiter.check(req)) return rateLimited();

  try {
    await connectDB();

    const keys = ENQUIRY_TYPES.map((type) => ENQUIRY_ACK_CONFIG_KEYS[type]);
    const docs = (await SiteConfig.find({
      configKey: { $in: keys },
    }).lean()) as unknown as Array<{
      configKey?: string;
      configValue?: string;
    }>;

    const storedByKey = new Map(
      docs.map((doc) => [doc.configKey ?? "", doc.configValue ?? ""])
    );

    const templates: Record<
      string,
      { subject: string; body: string; source: "stored" | "default" }
    > = {};
    for (const type of ENQUIRY_TYPES) {
      const resolved = resolveAckTemplate(
        type,
        storedByKey.get(ENQUIRY_ACK_CONFIG_KEYS[type]) ?? null
      );
      templates[type] = { ...resolved.template, source: resolved.source };
    }

    return NextResponse.json({
      success: true,
      data: {
        templates,
        defaults: ENQUIRY_ACK_DEFAULTS,
        placeholders: ENQUIRY_ACK_PLACEHOLDERS,
      },
    });
  } catch (error) {
    console.error("Admin enquiry email templates get error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load email templates." },
      { status: 500 }
    );
  }
}

/* ── PUT — validate and store one template ────────────────────────────── */

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (ackTemplateLimiter.check(req)) return rateLimited();

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { success: false, message: "Invalid request body." },
        { status: 400 }
      );
    }

    const payload = body as Record<string, unknown>;
    const validated = validateAckTemplate(payload.type, {
      subject: payload.subject,
      body: payload.body,
    });
    if (!validated.ok) {
      return NextResponse.json(
        { success: false, message: validated.message },
        { status: 400 }
      );
    }

    const type = payload.type;
    if (!isEnquiryType(type)) {
      // validateAckTemplate already guarantees this; belt and braces before
      // the value is used to build a storage key.
      return NextResponse.json(
        { success: false, message: "Invalid enquiry type." },
        { status: 400 }
      );
    }

    await connectDB();

    await SiteConfig.findOneAndUpdate(
      { configKey: ENQUIRY_ACK_CONFIG_KEYS[type] },
      { configValue: JSON.stringify(validated.value) },
      { upsert: true, new: true }
    );

    return NextResponse.json({
      success: true,
      message: "Template saved. New enquiries will use it immediately.",
      data: { type, ...validated.value, source: "stored" },
    });
  } catch (error) {
    console.error("Admin enquiry email templates update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to save the template." },
      { status: 500 }
    );
  }
}

/* ── DELETE — drop the override, restoring the built-in default ───────── */

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (ackTemplateLimiter.check(req)) return rateLimited();

  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    if (!isEnquiryType(type)) {
      return NextResponse.json(
        { success: false, message: "Invalid enquiry type." },
        { status: 400 }
      );
    }

    await connectDB();

    // Idempotent: deleting an override that was never stored still succeeds,
    // and the effective template is the default either way.
    await SiteConfig.deleteOne({ configKey: ENQUIRY_ACK_CONFIG_KEYS[type] });

    return NextResponse.json({
      success: true,
      message: "Template reset to the application default.",
      data: { type, ...ENQUIRY_ACK_DEFAULTS[type], source: "default" },
    });
  } catch (error) {
    console.error("Admin enquiry email templates reset error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to reset the template." },
      { status: 500 }
    );
  }
}
