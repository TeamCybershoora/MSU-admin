/**
 * Site Config API — key-value configuration store for the MSU system.
 *
 * Endpoints:
 *   GET  /api/admin/site-config?key=<key>  — read a config value
 *   PUT  /api/admin/site-config            — upsert a config value
 *
 * All endpoints require admin JWT authentication.
 *
 * Current usage:
 *   - "college_pdf_url" — common PDF URL for the college directory
 *     (managed by the College Management page)
 *
 * Design: Uses Mongoose upsert so PUT creates or updates in one operation.
 * Config keys are stored lowercase for case-insensitive lookup.
 *
 * Security:
 * - Rate limited (60 req / 15 min per IP)
 * - All writes require admin JWT
 */
import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import SiteConfig from "@/models/SiteConfig";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";

const adminSiteConfigLimiter = createRateLimiter({
  name: "admin-site-config",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSiteConfigLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const key = url.searchParams.get("key")?.trim() || "";

    if (!key) {
      return NextResponse.json(
        { success: false, message: "Config key is required." },
        { status: 400 }
      );
    }

    const doc = await SiteConfig.findOne({
      configKey: key.toLowerCase(),
    }).lean() as unknown as { configValue?: string } | null;

    return NextResponse.json({
      success: true,
      data: {
        key: key.toLowerCase(),
        value: doc?.configValue || "",
      },
    });
  } catch (error) {
    console.error("Admin site-config get error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load site config." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { key, value } = body;

    if (!key || typeof key !== "string" || !key.trim()) {
      return NextResponse.json(
        { success: false, message: "Config key is required." },
        { status: 400 }
      );
    }

    if (value === undefined || value === null || typeof value !== "string") {
      return NextResponse.json(
        { success: false, message: "Config value must be a string." },
        { status: 400 }
      );
    }

    await SiteConfig.findOneAndUpdate(
      { configKey: key.trim().toLowerCase() },
      { configValue: value.trim() },
      { upsert: true, new: true }
    );

    return NextResponse.json({
      success: true,
      message: "Site config updated successfully.",
    });
  } catch (error) {
    console.error("Admin site-config update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update site config." },
      { status: 500 }
    );
  }
}
