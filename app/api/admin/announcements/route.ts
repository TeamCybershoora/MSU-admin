/**
 * /api/admin/announcements — Announcement Bar Management (ADMIN).
 *
 * The Admin portal is the AUTHORITATIVE WRITER for the shared `announcements`
 * collection. The public MSU website only reads it (GET /api/announcements).
 * Every endpoint requires an admin JWT (authenticateAdmin) and is rate limited;
 * the UI is never trusted.
 *
 *   GET     list every announcement (enabled + disabled), in display order.
 *   POST    create an announcement.
 *   PUT     update an announcement (details, enable/disable, schedule, order).
 *   DELETE  delete an announcement.
 *
 * Scheduling is stored as UTC instants. Incoming bare `datetime-local` wall
 * clocks are interpreted as IST (Asia/Kolkata) by parseOptionalDate; the admin
 * page sends explicit ISO UTC strings. The window rule (endAt > startAt) is
 * enforced here server-side, not only in the browser.
 */
import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Announcement, { toSafeAnnouncement } from "@/models/Announcement";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  parseDisplayOrder,
  parseOptionalDate,
  validateHeadline,
  validateHref,
  validateOptionalText,
  validateScheduleWindow,
} from "@/lib/announcement-validation";

const adminAnnouncementLimiter = createRateLimiter({
  name: "admin-announcements",
  windowMs: 15 * 60 * 1000,
  limit: 120,
});

function fail(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

/** Explain a Mongoose ValidationError as a single 400 message. */
function validationErrorResponse(error: unknown): NextResponse | null {
  const err = error as {
    name?: string;
    errors?: Record<string, { message: string }>;
  };
  if (err.name === "ValidationError" && err.errors) {
    const messages = Object.values(err.errors).map((e) => e.message);
    return fail(messages.join(" "));
  }
  return null;
}

/* ── GET — list every announcement ──────────────────────────────── */

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminAnnouncementLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const items = await Announcement.find({})
      .sort({ displayOrder: 1, createdAt: 1 })
      .lean();

    return NextResponse.json({
      success: true,
      data: items.map((item) =>
        toSafeAnnouncement(item as unknown as Parameters<typeof toSafeAnnouncement>[0])
      ),
    });
  } catch (error) {
    console.error("Admin announcements list error:", error);
    return fail("Unable to load announcements.", 500);
  }
}

/* ── POST — create ──────────────────────────────────────────────── */

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminAnnouncementLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    const headline = validateHeadline(body.headline);
    if (!headline.ok) return fail(headline.message);

    const eyebrow = validateOptionalText(body.eyebrow, "Eyebrow", 120);
    if (!eyebrow.ok) return fail(eyebrow.message);

    const sub = validateOptionalText(body.sub, "Supporting text", 300);
    if (!sub.ok) return fail(sub.message);

    const href = validateHref(body.href);
    if (!href.ok) return fail(href.message);

    const order = parseDisplayOrder(body.displayOrder);
    if (order === null) return fail("Display order must be zero or greater.");

    const start = parseOptionalDate(body.startAt);
    if (!start.ok) return fail(start.message);

    const end = parseOptionalDate(body.endAt);
    if (!end.ok) return fail(end.message);

    const window = validateScheduleWindow(start.data, end.data);
    if (!window.ok) return fail(window.message);

    const record = await Announcement.create({
      eyebrow: eyebrow.data,
      headline: headline.data,
      sub: sub.data,
      href: href.data,
      isEnabled: body.isEnabled === undefined ? true : Boolean(body.isEnabled),
      startAt: start.data,
      endAt: end.data,
      displayOrder: order,
      createdBy: auth.admin.adminId,
      updatedBy: auth.admin.adminId,
    });

    return NextResponse.json({
      success: true,
      message: "Announcement created successfully.",
      item: toSafeAnnouncement(record),
    });
  } catch (error) {
    const validation = validationErrorResponse(error);
    if (validation) return validation;

    console.error("Admin announcement create error:", error);
    return fail("Unable to create the announcement.", 500);
  }
}

/* ── PUT — update / enable / disable / reorder ──────────────────── */

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminAnnouncementLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    const { id } = body;
    if (typeof id !== "string" || !id.trim()) {
      return fail("Announcement id is required.");
    }

    const record = await Announcement.findById(id);
    if (!record) return fail("Announcement not found.", 404);

    if (body.headline !== undefined) {
      const headline = validateHeadline(body.headline);
      if (!headline.ok) return fail(headline.message);
      record.headline = headline.data;
    }

    if (body.eyebrow !== undefined) {
      const eyebrow = validateOptionalText(body.eyebrow, "Eyebrow", 120);
      if (!eyebrow.ok) return fail(eyebrow.message);
      record.eyebrow = eyebrow.data;
    }

    if (body.sub !== undefined) {
      const sub = validateOptionalText(body.sub, "Supporting text", 300);
      if (!sub.ok) return fail(sub.message);
      record.sub = sub.data;
    }

    if (body.href !== undefined) {
      const href = validateHref(body.href);
      if (!href.ok) return fail(href.message);
      record.href = href.data;
    }

    if (body.displayOrder !== undefined) {
      const order = parseDisplayOrder(body.displayOrder);
      if (order === null) return fail("Display order must be zero or greater.");
      record.displayOrder = order;
    }

    if (body.isEnabled !== undefined) {
      record.isEnabled = Boolean(body.isEnabled);
    }

    let start = record.startAt;
    let end = record.endAt;
    let scheduleChanged = false;

    if (body.startAt !== undefined) {
      const parsed = parseOptionalDate(body.startAt);
      if (!parsed.ok) return fail(parsed.message);
      start = parsed.data;
      scheduleChanged = true;
    }

    if (body.endAt !== undefined) {
      const parsed = parseOptionalDate(body.endAt);
      if (!parsed.ok) return fail(parsed.message);
      end = parsed.data;
      scheduleChanged = true;
    }

    if (scheduleChanged) {
      const window = validateScheduleWindow(start, end);
      if (!window.ok) return fail(window.message);
      record.startAt = start;
      record.endAt = end;
    }

    record.updatedBy = auth.admin.adminId;
    await record.save();

    return NextResponse.json({
      success: true,
      message: "Announcement updated successfully.",
      item: toSafeAnnouncement(record),
    });
  } catch (error) {
    const validation = validationErrorResponse(error);
    if (validation) return validation;

    console.error("Admin announcement update error:", error);
    return fail("Unable to update the announcement.", 500);
  }
}

/* ── DELETE — remove ────────────────────────────────────────────── */

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminAnnouncementLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    const { id } = body;
    if (typeof id !== "string" || !id.trim()) {
      return fail("Announcement id is required.");
    }

    const record = await Announcement.findByIdAndDelete(id);
    if (!record) return fail("Announcement not found.", 404);

    return NextResponse.json({
      success: true,
      message: "Announcement deleted successfully.",
    });
  } catch (error) {
    console.error("Admin announcement delete error:", error);
    return fail("Unable to delete the announcement.", 500);
  }
}
