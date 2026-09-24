import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Notice, { toSafeNotice } from "@/models/Notice";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  NOTICE_CATEGORIES,
  VALID_STATUSES,
  VALID_CONTENT_TYPES,
  type NoticeCategory,
  type NoticeStatus,
  type ContentType,
} from "@/lib/notice-types";
import { escapeRegex } from "@/lib/validation";

const adminNoticeLimiter = createRateLimiter({
  name: "admin-notices",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim();
}

function validateNoticeBody(
  body: unknown
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }

  const b = body as Record<string, unknown>;

  const title = trimString(b.title);
  if (!title) return { ok: false, error: "Title is required." };

  const summary = trimString(b.summary);
  if (!summary) return { ok: false, error: "Summary is required." };

  const content = trimString(b.content);
  if (!content) return { ok: false, error: "Content is required." };

  const category = trimString(b.category);
  if (!category || !NOTICE_CATEGORIES.includes(category as NoticeCategory)) {
    return { ok: false, error: `Category must be one of: ${NOTICE_CATEGORIES.join(", ")}.` };
  }

  let contentType: ContentType = "notice";
  if (b.contentType !== undefined) {
    const ct = trimString(b.contentType);
    if (!ct || !VALID_CONTENT_TYPES.includes(ct as ContentType)) {
      return { ok: false, error: `Content type must be one of: ${VALID_CONTENT_TYPES.join(", ")}.` };
    }
    contentType = ct as ContentType;
  }

  if (!b.publishedDate) return { ok: false, error: "Published date is required." };
  const publishedDate = new Date(b.publishedDate as string);
  if (isNaN(publishedDate.getTime())) return { ok: false, error: "Published date must be a valid date." };

  let status: NoticeStatus = "draft";
  if (b.status !== undefined) {
    const s = trimString(b.status);
    if (!s || !VALID_STATUSES.includes(s as NoticeStatus)) {
      return { ok: false, error: `Status must be one of: ${VALID_STATUSES.join(", ")}.` };
    }
    status = s as NoticeStatus;
  }

  const isNewNotice = b.isNewNotice === true;
  const isImportant = b.isImportant === true;
  const attachmentName = trimString(b.attachmentName) ?? "";
  const attachmentUrl = trimString(b.attachmentUrl) ?? "";

  return {
    ok: true,
    data: { title, summary, content, category, contentType, publishedDate, status, isNewNotice, isImportant, attachmentName, attachmentUrl },
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

  if (b.title !== undefined) { const title = trimString(b.title); if (!title) return { ok: false, error: "Title cannot be empty." }; cleaned.title = title; }
  if (b.summary !== undefined) { const summary = trimString(b.summary); if (!summary) return { ok: false, error: "Summary cannot be empty." }; cleaned.summary = summary; }
  if (b.content !== undefined) { const content = trimString(b.content); if (!content) return { ok: false, error: "Content cannot be empty." }; cleaned.content = content; }

  if (b.category !== undefined) {
    const category = trimString(b.category);
    if (!category || !NOTICE_CATEGORIES.includes(category as NoticeCategory)) {
      return { ok: false, error: `Category must be one of: ${NOTICE_CATEGORIES.join(", ")}.` };
    }
    cleaned.category = category;
  }

  if (b.contentType !== undefined) {
    const ct = trimString(b.contentType);
    if (!ct || !VALID_CONTENT_TYPES.includes(ct as ContentType)) {
      return { ok: false, error: `Content type must be one of: ${VALID_CONTENT_TYPES.join(", ")}.` };
    }
    cleaned.contentType = ct;
  }

  if (b.publishedDate !== undefined) {
    const publishedDate = new Date(b.publishedDate as string);
    if (isNaN(publishedDate.getTime())) return { ok: false, error: "Published date must be a valid date." };
    cleaned.publishedDate = publishedDate;
  }

  if (b.status !== undefined) {
    const status = trimString(b.status);
    if (!status || !VALID_STATUSES.includes(status as NoticeStatus)) {
      return { ok: false, error: `Status must be one of: ${VALID_STATUSES.join(", ")}.` };
    }
    cleaned.status = status;
  }

  if (b.isNewNotice !== undefined) cleaned.isNewNotice = b.isNewNotice === true;
  if (b.isImportant !== undefined) cleaned.isImportant = b.isImportant === true;
  if (b.attachmentName !== undefined) cleaned.attachmentName = trimString(b.attachmentName) ?? "";
  if (b.attachmentUrl !== undefined) cleaned.attachmentUrl = trimString(b.attachmentUrl) ?? "";

  if (Object.keys(cleaned).length === 0) return { ok: false, error: "No valid fields to update." };

  return { ok: true, data: cleaned };
}

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNoticeLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const search = url.searchParams.get("search")?.trim() || "";
    const category = url.searchParams.get("category")?.trim() || "";
    const contentType = url.searchParams.get("contentType")?.trim() || "";
    const status = url.searchParams.get("status")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { isDeleted: false };

    if (contentType && contentType !== "All" && VALID_CONTENT_TYPES.includes(contentType as ContentType)) {
      query.contentType = contentType;
    }

    if (search) {
      query.$or = [
        { title: { $regex: escapeRegex(search), $options: "i" } },
        { summary: { $regex: escapeRegex(search), $options: "i" } },
        { category: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    if (category && category !== "All") {
      if (NOTICE_CATEGORIES.includes(category as NoticeCategory)) {
        query.category = category;
      }
    }

    if (status && status !== "All") {
      if (VALID_STATUSES.includes(status as NoticeStatus)) {
        query.status = status;
      }
    }

    const [notices, total] = await Promise.all([
      Notice.find(query)
        .sort({ publishedDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notice.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: notices.map((n) => toSafeNotice(n as unknown as Parameters<typeof toSafeNotice>[0])),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Admin notices list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load notices." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNoticeLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const validation = validateNoticeBody(body);
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, message: validation.error },
        { status: 400 }
      );
    }

    const notice = await Notice.create(validation.data);

    return NextResponse.json({
      success: true,
      message: "Notice created successfully.",
      notice: toSafeNotice(notice as unknown as Parameters<typeof toSafeNotice>[0]),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      errors?: Record<string, { message: string }>;
    };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin notice create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create notice." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNoticeLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { noticeId } = body as Record<string, unknown>;

    if (!noticeId || typeof noticeId !== "string") {
      return NextResponse.json(
        { success: false, message: "Notice ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(noticeId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Notice ID format." },
        { status: 400 }
      );
    }

    const validation = validateUpdateBody(body);
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, message: validation.error },
        { status: 400 }
      );
    }

    const notice = await Notice.findById(noticeId);
    if (!notice) {
      return NextResponse.json(
        { success: false, message: "Notice not found." },
        { status: 404 }
      );
    }

    const updates = validation.data;
    for (const [key, value] of Object.entries(updates)) {
      (notice as Record<string, unknown>)[key] = value;
    }

    await notice.save();

    return NextResponse.json({
      success: true,
      message: "Notice updated successfully.",
      notice: toSafeNotice(notice as unknown as Parameters<typeof toSafeNotice>[0]),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      errors?: Record<string, { message: string }>;
    };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin notice update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update notice." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminNoticeLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { noticeId } = body as Record<string, unknown>;

    if (!noticeId || typeof noticeId !== "string") {
      return NextResponse.json(
        { success: false, message: "Notice ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(noticeId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Notice ID format." },
        { status: 400 }
      );
    }

    const notice = await Notice.findOne({ _id: noticeId, isDeleted: false });
    if (!notice) {
      return NextResponse.json(
        { success: false, message: "Notice not found or already deleted." },
        { status: 404 }
      );
    }

    notice.isDeleted = true;
    await notice.save();

    return NextResponse.json({
      success: true,
      message: "Notice deleted successfully.",
    });
  } catch (error) {
    console.error("Admin notice delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete notice." },
      { status: 500 }
    );
  }
}
