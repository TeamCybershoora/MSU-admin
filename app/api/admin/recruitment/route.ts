/**
 * /api/admin/recruitment — Recruitment Management (ADMIN).
 *
 * The Admin portal is the AUTHORITATIVE WRITER for the shared `recruitments`
 * collection. The public site only reads it. Every endpoint requires an admin
 * JWT (authenticateAdmin) and is rate limited; the UI is never trusted.
 *
 *   GET     list one section (filters: type, status, search, page, limit) plus
 *           BOTH section totals, so the page's counts come from real data.
 *   POST    create a record.
 *   PUT     update a record (details, publish/unpublish, display order, replace
 *           or clear the document).
 *   DELETE  delete a record and its stored PDF.
 *
 * DOCUMENT STORAGE — deliberate reuse:
 *   There is no separate recruitment upload/storage system. The existing
 *   GridFS PDF implementation is reused end to end:
 *     POST /api/admin/syllabus/upload   → stores the PDF, returns an absolute URL
 *     GET  /api/syllabus/pdf/[id]       → serves it publicly (used cross-origin
 *                                          by the public MSU site)
 *   A record stores that absolute URL in `documentUrl` (the public contract's
 *   field) and the sanitised name in `documentName`. Only references this
 *   server issued are accepted (parseSyllabusPdfId), so an arbitrary URL can
 *   never be stored; a superseded document is removed with deleteSyllabusPdf.
 *
 * No image fields exist anywhere in this feature.
 */
import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Recruitment, { toAdminRecruitment } from "@/models/Recruitment";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { escapeRegex, safePdfFilename } from "@/lib/validation";
import { deleteSyllabusPdf, parseSyllabusPdfId } from "@/lib/pdf-storage";
import {
  parseDisplayOrder,
  parsePublishedDate,
  parseRecruitmentStatus,
  parseRecruitmentType,
  validateDescription,
  validateTitle,
  type ValidationResult,
} from "@/lib/recruitment-validation";

const adminRecruitmentLimiter = createRateLimiter({
  name: "admin-recruitment",
  windowMs: 15 * 60 * 1000,
  limit: 120,
});

function fail(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

/** Result of resolving the optional document fields of a request body. */
type DocumentInput = { documentUrl: string; documentName: string } | undefined;

/**
 * Resolve the optional document reference from a request body.
 *
 *   undefined      → the document was not mentioned (leave it untouched)
 *   null / ""      → explicitly clear it
 *   string         → must be a reference this server issued (parseSyllabusPdfId)
 *
 * Only upload references are accepted, so an arbitrary URL or filesystem path
 * can never reach a recruitment record.
 */
function parseDocument(
  rawUrl: unknown,
  rawName: unknown
): ValidationResult<DocumentInput> {
  if (rawUrl === undefined) return { ok: true, data: undefined };

  if (rawUrl === null || rawUrl === "") {
    return { ok: true, data: { documentUrl: "", documentName: "" } };
  }

  if (typeof rawUrl !== "string" || !parseSyllabusPdfId(rawUrl)) {
    return {
      ok: false,
      message: "Invalid document reference. Upload the PDF before saving.",
    };
  }

  return {
    ok: true,
    data: {
      documentUrl: rawUrl,
      documentName:
        typeof rawName === "string" && rawName.trim()
          ? safePdfFilename(rawName)
          : "",
    },
  };
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

/* ── GET — list one section + both totals ───────────────────────── */

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminRecruitmentLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const rawType = url.searchParams.get("type")?.trim() || "";
    const rawStatus = url.searchParams.get("status")?.trim() || "";
    const search = url.searchParams.get("search")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20)
    );

    const query: Record<string, unknown> = { isDeleted: false };

    if (rawType) {
      const type = parseRecruitmentType(rawType);
      if (!type) return fail("Unknown recruitment section.");
      query.type = type;
    }

    if (rawStatus && rawStatus !== "all") {
      const status = parseRecruitmentStatus(rawStatus);
      if (!status) return fail("Status must be 'draft' or 'published'.");
      query.status = status;
    }

    if (search) {
      const pattern = escapeRegex(search);
      query.$or = [
        { title: { $regex: pattern, $options: "i" } },
        { description: { $regex: pattern, $options: "i" } },
      ];
    }

    const [records, total, jobOpenings, governmentOrders] = await Promise.all([
      Recruitment.find(query)
        .sort({ displayOrder: 1, publishedDate: -1, createdAt: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Recruitment.countDocuments(query),
      Recruitment.countDocuments({ type: "job-opening", isDeleted: false }),
      Recruitment.countDocuments({ type: "government-order", isDeleted: false }),
    ]);

    return NextResponse.json({
      success: true,
      data: records.map((record) =>
        toAdminRecruitment(
          record as unknown as Parameters<typeof toAdminRecruitment>[0]
        )
      ),
      counts: { jobOpenings, governmentOrders },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error("Admin recruitment list error:", error);
    return fail("Unable to load recruitment records.", 500);
  }
}

/* ── POST — create ──────────────────────────────────────────────── */

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminRecruitmentLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    const type = parseRecruitmentType(body.type);
    if (!type) return fail("A valid recruitment section is required.");

    const title = validateTitle(body.title);
    if (!title.ok) return fail(title.message);

    const description = validateDescription(body.description);
    if (!description.ok) return fail(description.message);

    const publishedDate = parsePublishedDate(body.publishedDate);
    if (!publishedDate) return fail("A valid publish/issue date is required.");

    const order = parseDisplayOrder(body.displayOrder);
    if (order === null) return fail("Display order must be zero or greater.");

    let status = parseRecruitmentStatus(body.status);
    if (body.status !== undefined && !status) {
      return fail("Status must be 'draft' or 'published'.");
    }
    status = status ?? "draft";

    const document = parseDocument(body.documentUrl, body.documentName);
    if (!document.ok) return fail(document.message);

    const record = await Recruitment.create({
      type,
      title: title.data,
      description: description.data,
      publishedDate,
      documentUrl: document.data?.documentUrl ?? "",
      documentName: document.data?.documentName ?? "",
      status,
      displayOrder: order,
      isDeleted: false,
    });

    return NextResponse.json({
      success: true,
      message: "Recruitment record created successfully.",
      item: toAdminRecruitment(record),
    });
  } catch (error) {
    const validation = validationErrorResponse(error);
    if (validation) return validation;

    console.error("Admin recruitment create error:", error);
    return fail("Unable to create the recruitment record.", 500);
  }
}

/* ── PUT — update (details, publish/unpublish, order, document) ──── */

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminRecruitmentLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    const { id } = body;
    if (typeof id !== "string" || !id.trim()) {
      return fail("Recruitment record id is required.");
    }

    const record = await Recruitment.findById(id);
    if (!record) return fail("Recruitment record not found.", 404);

    const previousDocumentUrl = record.documentUrl;

    if (body.type !== undefined) {
      const type = parseRecruitmentType(body.type);
      if (!type) return fail("A valid recruitment section is required.");
      record.type = type;
    }

    if (body.title !== undefined) {
      const title = validateTitle(body.title);
      if (!title.ok) return fail(title.message);
      record.title = title.data;
    }

    if (body.description !== undefined) {
      const description = validateDescription(body.description);
      if (!description.ok) return fail(description.message);
      record.description = description.data;
    }

    if (body.publishedDate !== undefined) {
      const publishedDate = parsePublishedDate(body.publishedDate);
      if (!publishedDate) return fail("A valid publish/issue date is required.");
      record.publishedDate = publishedDate;
    }

    if (body.status !== undefined) {
      const status = parseRecruitmentStatus(body.status);
      if (!status) return fail("Status must be 'draft' or 'published'.");
      record.status = status;
    }

    if (body.displayOrder !== undefined) {
      const order = parseDisplayOrder(body.displayOrder);
      if (order === null) return fail("Display order must be zero or greater.");
      record.displayOrder = order;
    }

    const document = parseDocument(body.documentUrl, body.documentName);
    if (!document.ok) return fail(document.message);
    if (document.data !== undefined) {
      record.documentUrl = document.data.documentUrl;
      record.documentName = document.data.documentName;
    }

    await record.save();

    // The document was replaced or cleared — remove the superseded bytes so no
    // orphaned PDF remains in GridFS.
    if (
      document.data !== undefined &&
      previousDocumentUrl &&
      previousDocumentUrl !== record.documentUrl
    ) {
      const staleId = parseSyllabusPdfId(previousDocumentUrl);
      if (staleId) await deleteSyllabusPdf(staleId);
    }

    return NextResponse.json({
      success: true,
      message: "Recruitment record updated successfully.",
      item: toAdminRecruitment(record),
    });
  } catch (error) {
    const validation = validationErrorResponse(error);
    if (validation) return validation;

    console.error("Admin recruitment update error:", error);
    return fail("Unable to update the recruitment record.", 500);
  }
}

/* ── DELETE — remove a record and its stored PDF ────────────────── */

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminRecruitmentLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    const { id } = body;
    if (typeof id !== "string" || !id.trim()) {
      return fail("Recruitment record id is required.");
    }

    const record = await Recruitment.findByIdAndDelete(id);
    if (!record) return fail("Recruitment record not found.", 404);

    // Remove the stored document together with the record.
    const documentId = record.documentUrl
      ? parseSyllabusPdfId(record.documentUrl)
      : null;
    if (documentId) await deleteSyllabusPdf(documentId);

    return NextResponse.json({
      success: true,
      message: "Recruitment record deleted successfully.",
    });
  } catch (error) {
    console.error("Admin recruitment delete error:", error);
    return fail("Unable to delete the recruitment record.", 500);
  }
}
