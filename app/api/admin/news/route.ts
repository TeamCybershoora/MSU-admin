/**
 * Admin News API — CRUD for the dedicated university News system.
 *
 * Endpoints:
 *   GET    /api/admin/news  — list news (search / status / pagination)
 *   POST   /api/admin/news  — create a news item
 *   PUT    /api/admin/news  — update a news item (optionally replace its image)
 *   DELETE /api/admin/news  — soft-delete a news item
 *
 * This API is intentionally INDEPENDENT of /api/admin/notices. News is a
 * separate collection with its own lifecycle; Notices are untouched.
 *
 * Security:
 * - Every endpoint requires an admin JWT (authenticateAdmin) and is rate limited.
 * - `imageId` must be a well-formed GridFS ObjectId, so nothing from the request
 *   can reach an arbitrary path. Images are uploaded separately through the
 *   shared POST /api/admin/images/upload endpoint (magic-byte + MIME + size
 *   validated there).
 * - Replacing or clearing an image deletes the superseded GridFS bytes.
 * - Responses expose only the admin-safe shape (toSafeNews).
 */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import News, { toSafeNews } from "@/models/News";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { NEWS_STATUSES, type NewsStatus } from "@/lib/news-types";
import { escapeRegex } from "@/lib/validation";
import { deleteImage, isImageId } from "@/lib/image-storage";

const adminNewsLimiter = createRateLimiter({
  name: "admin-news",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim();
}

/** Parse an optional display order into a non-negative integer. */
function parseDisplayOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function validateNewsBody(
  body: unknown
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }

  const b = body as Record<string, unknown>;

  const title = trimString(b.title);
  if (!title) return { ok: false, error: "Title is required." };

  const summary = trimString(b.summary) ?? "";
  const content = trimString(b.content) ?? "";

  if (!b.publishedDate) return { ok: false, error: "Publication date is required." };
  const publishedDate = new Date(b.publishedDate as string);
  if (isNaN(publishedDate.getTime())) {
    return { ok: false, error: "Publication date must be a valid date." };
  }

  let status: NewsStatus = "draft";
  if (b.status !== undefined) {
    const s = trimString(b.status);
    if (!s || !NEWS_STATUSES.includes(s as NewsStatus)) {
      return { ok: false, error: `Status must be one of: ${NEWS_STATUSES.join(", ")}.` };
    }
    status = s as NewsStatus;
  }

  const displayOrder = parseDisplayOrder(b.displayOrder);
  if (displayOrder === null) {
    return { ok: false, error: "Display order must be zero or greater." };
  }

  // Optional featured image: either empty, or a GridFS id produced by the
  // shared upload endpoint. Any other value is rejected so a record can never
  // reference an arbitrary path or a malformed id.
  const imageId = trimString(b.imageId) ?? "";
  if (imageId && !isImageId(imageId)) {
    return { ok: false, error: "Invalid featured image reference." };
  }

  const imageName = trimString(b.imageName) ?? "";
  const imageAlt = trimString(b.imageAlt) ?? "";

  return {
    ok: true,
    data: {
      title,
      summary,
      content,
      imageId,
      imageName,
      imageAlt,
      publishedDate,
      status,
      displayOrder,
    },
  };
}

function validateUpdateBody(
  body: unknown
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }

  const b = body as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  if (b.title !== undefined) {
    const title = trimString(b.title);
    if (!title) return { ok: false, error: "Title cannot be empty." };
    cleaned.title = title;
  }
  if (b.summary !== undefined) cleaned.summary = trimString(b.summary) ?? "";
  if (b.content !== undefined) cleaned.content = trimString(b.content) ?? "";

  if (b.publishedDate !== undefined) {
    const publishedDate = new Date(b.publishedDate as string);
    if (isNaN(publishedDate.getTime())) {
      return { ok: false, error: "Publication date must be a valid date." };
    }
    cleaned.publishedDate = publishedDate;
  }

  if (b.status !== undefined) {
    const status = trimString(b.status);
    if (!status || !NEWS_STATUSES.includes(status as NewsStatus)) {
      return { ok: false, error: `Status must be one of: ${NEWS_STATUSES.join(", ")}.` };
    }
    cleaned.status = status;
  }

  if (b.displayOrder !== undefined) {
    const displayOrder = parseDisplayOrder(b.displayOrder);
    if (displayOrder === null) {
      return { ok: false, error: "Display order must be zero or greater." };
    }
    cleaned.displayOrder = displayOrder;
  }

  if (b.imageId !== undefined) {
    const imageId = trimString(b.imageId) ?? "";
    if (imageId && !isImageId(imageId)) {
      return { ok: false, error: "Invalid featured image reference." };
    }
    cleaned.imageId = imageId;
  }
  if (b.imageName !== undefined) cleaned.imageName = trimString(b.imageName) ?? "";
  if (b.imageAlt !== undefined) cleaned.imageAlt = trimString(b.imageAlt) ?? "";

  if (Object.keys(cleaned).length === 0) {
    return { ok: false, error: "No valid fields to update." };
  }

  return { ok: true, data: cleaned };
}

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNewsLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const search = url.searchParams.get("search")?.trim() || "";
    const status = url.searchParams.get("status")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { isDeleted: false };

    if (status && status !== "All" && NEWS_STATUSES.includes(status as NewsStatus)) {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { title: { $regex: escapeRegex(search), $options: "i" } },
        { summary: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      News.find(query)
        .sort({ publishedDate: -1, displayOrder: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      News.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: items.map((n) => toSafeNews(n as unknown as Parameters<typeof toSafeNews>[0])),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Admin news list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load news." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNewsLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const validation = validateNewsBody(body);
    if (!validation.ok) {
      return NextResponse.json({ success: false, message: validation.error }, { status: 400 });
    }

    const item = await News.create(validation.data);

    return NextResponse.json({
      success: true,
      message: "News created successfully.",
      item: toSafeNews(item as unknown as Parameters<typeof toSafeNews>[0]),
    });
  } catch (error: unknown) {
    const err = error as { name?: string; errors?: Record<string, { message: string }> };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json({ success: false, message: messages.join(" ") }, { status: 400 });
    }

    console.error("Admin news create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create news." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNewsLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { newsId } = body as Record<string, unknown>;

    if (!newsId || typeof newsId !== "string") {
      return NextResponse.json({ success: false, message: "News ID is required." }, { status: 400 });
    }

    if (!mongoose.Types.ObjectId.isValid(newsId)) {
      return NextResponse.json({ success: false, message: "Invalid News ID format." }, { status: 400 });
    }

    const validation = validateUpdateBody(body);
    if (!validation.ok) {
      return NextResponse.json({ success: false, message: validation.error }, { status: 400 });
    }

    const item = await News.findOne({ _id: newsId, isDeleted: false });
    if (!item) {
      return NextResponse.json({ success: false, message: "News item not found." }, { status: 404 });
    }

    const previousImageId = item.imageId;

    for (const [key, value] of Object.entries(validation.data)) {
      (item as Record<string, unknown>)[key] = value;
    }

    await item.save();

    // The featured image was replaced or cleared — drop the superseded bytes.
    if (item.imageId !== previousImageId) {
      await deleteImage(previousImageId);
    }

    return NextResponse.json({
      success: true,
      message: "News updated successfully.",
      item: toSafeNews(item as unknown as Parameters<typeof toSafeNews>[0]),
    });
  } catch (error: unknown) {
    const err = error as { name?: string; errors?: Record<string, { message: string }> };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json({ success: false, message: messages.join(" ") }, { status: 400 });
    }

    console.error("Admin news update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update news." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNewsLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { newsId } = body as Record<string, unknown>;

    if (!newsId || typeof newsId !== "string") {
      return NextResponse.json({ success: false, message: "News ID is required." }, { status: 400 });
    }

    if (!mongoose.Types.ObjectId.isValid(newsId)) {
      return NextResponse.json({ success: false, message: "Invalid News ID format." }, { status: 400 });
    }

    const item = await News.findOne({ _id: newsId, isDeleted: false });
    if (!item) {
      return NextResponse.json(
        { success: false, message: "News item not found or already deleted." },
        { status: 404 }
      );
    }

    // Soft delete: the record (and its image bytes) are preserved so nothing is
    // destroyed. It disappears from the admin list and the public API.
    item.isDeleted = true;
    await item.save();

    return NextResponse.json({ success: true, message: "News deleted successfully." });
  } catch (error) {
    console.error("Admin news delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete news." },
      { status: 500 }
    );
  }
}
