/**
 * POST /api/admin/leadership/restore — restore a fixed leadership position to
 * the university's default information.
 *
 * Server-side by design: the default values come from lib/leadership-defaults.ts
 * (the single source of truth) and the browser never supplies them — a request
 * carries only the fixed `role`. If no record exists for the role, one is
 * created; otherwise the existing record is overwritten with the defaults.
 *
 * The default photograph is read from the admin app's assets, verified by file
 * signature and stored through the SAME shared GridFS pipeline as every other
 * upload (lib/image-storage.ts) — no new bucket or upload utility.
 *
 * Requires admin JWT authentication and is rate limited.
 */
import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Leadership, { toSafeLeadership, type ILeadership } from "@/models/Leadership";
import { isLeadershipRole } from "@/lib/leadership";
import {
  LEADERSHIP_DEFAULTS,
  readLeadershipDefaultImage,
} from "@/lib/leadership-defaults";
import { deleteImage, saveImage } from "@/lib/image-storage";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";

const restoreLimiter = createRateLimiter({
  name: "admin-leadership-restore",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (restoreLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const role = body?.role;
    if (!isLeadershipRole(role)) {
      return NextResponse.json(
        { success: false, message: "A valid fixed role is required." },
        { status: 400 }
      );
    }

    const defaults = LEADERSHIP_DEFAULTS[role];

    const image = readLeadershipDefaultImage(role);
    if (!image) {
      return NextResponse.json(
        {
          success: false,
          message: "The default photograph for this position is unavailable.",
        },
        { status: 500 }
      );
    }

    const imageId = await saveImage(image.data, image.filename, image.contentType);

    const existing = await Leadership.findOne({ role });
    const previousImageId = existing?.imageId;

    const payload = {
      name: defaults.name,
      designation: defaults.designation,
      description: defaults.description,
      altText: defaults.altText,
      displayOrder: defaults.displayOrder,
      imageId,
      imageName: image.filename,
      isActive: true,
    };

    let item: ILeadership;
    if (existing) {
      Object.assign(existing, payload);
      item = await existing.save();
    } else {
      item = await Leadership.create({ role, ...payload });
    }

    // The default photograph replaced the previous one — drop the old bytes.
    if (previousImageId && previousImageId !== imageId) {
      await deleteImage(previousImageId);
    }

    return NextResponse.json({
      success: true,
      message: `${defaults.designation} restored to the default information.`,
      item: toSafeLeadership(item),
    });
  } catch (error: unknown) {
    const err = error as { name?: string; errors?: Record<string, { message: string }> };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin leadership restore error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to restore the default information." },
      { status: 500 }
    );
  }
}
