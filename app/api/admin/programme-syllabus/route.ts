/**
 * /api/admin/programme-syllabus
 *
 * Manages the ONE official programme-level syllabus PDF (e.g. the complete
 * "BCA Complete Syllabus 2026-27.pdf"), independent of any semester/subject
 * records. This is an additive layer on top of the existing per-semester
 * syllabus system and never touches those documents.
 *
 *   GET    ?programme=BCA — list programme syllabus documents (all, or one)
 *   POST   { programme, pdfUrl, pdfName } — create/replace the programme PDF
 *   DELETE ?programme=BCA — remove the programme PDF (and its GridFS file)
 *
 * Backward compatibility:
 * - This route is new; no existing route or response was changed.
 * - No existing syllabus record is read, written or deleted here.
 *
 * Security (reuses the established syllabus controls):
 * - Admin JWT required (authenticateAdmin) for every method.
 * - Rate limited per IP.
 * - Only a URL previously issued by POST /api/admin/syllabus/upload is
 *   accepted (validated with parseSyllabusPdfId), never an arbitrary link.
 * - Responses expose only programme + public PDF URL/name.
 *
 * Storage: PDF bytes are stored/replaced/removed through the existing
 * lib/pdf-storage.ts (MongoDB GridFS). No second storage mechanism is added.
 */

import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import ProgrammeSyllabus, {
  toSafeProgrammeSyllabus,
} from "@/models/ProgrammeSyllabus";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { parseProgrammeCode, safePdfFilename } from "@/lib/validation";
import { deleteSyllabusPdf, parseSyllabusPdfId } from "@/lib/pdf-storage";

export const runtime = "nodejs";

const programmeSyllabusLimiter = createRateLimiter({
  name: "admin-programme-syllabus",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (programmeSyllabusLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programmeParam = url.searchParams.get("programme");
    const query: Record<string, unknown> = {};

    if (programmeParam !== null) {
      const programme = parseProgrammeCode(programmeParam);
      if (!programme) {
        return NextResponse.json(
          { success: false, message: "Invalid programme." },
          { status: 400 }
        );
      }
      query.programme = programme;
    }

    const docs = await ProgrammeSyllabus.find(query)
      .sort({ programme: 1 })
      .lean();

    return NextResponse.json({
      success: true,
      data: docs.map((doc) => ({
        id: doc._id,
        programme: doc.programme,
        pdfUrl: doc.pdfUrl ?? null,
        pdfName: doc.pdfName ?? null,
        createdAt: doc.createdAt,
      })),
    });
  } catch (error) {
    console.error("Admin programme syllabus list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load programme syllabus." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (programmeSyllabusLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const programme = parseProgrammeCode(body?.programme);

    if (!programme) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Programme is required (1-20 characters: letters, spaces, dots, ampersands or hyphens).",
        },
        { status: 400 }
      );
    }

    const { pdfUrl, pdfName } = body ?? {};

    // Only references issued by POST /api/admin/syllabus/upload are accepted —
    // an arbitrary URL or filesystem path can never be stored.
    if (typeof pdfUrl !== "string" || !parseSyllabusPdfId(pdfUrl)) {
      return NextResponse.json(
        { success: false, message: "Invalid PDF reference." },
        { status: 400 }
      );
    }

    const nextPdfName =
      typeof pdfName === "string" && pdfName.trim()
        ? safePdfFilename(pdfName)
        : null;

    const existing = await ProgrammeSyllabus.findOne({ programme });
    const previousPdfUrl = existing?.pdfUrl ?? null;

    // The replacement GridFS file is already stored (upload happened first), so
    // the new reference is persisted before the old file is removed.
    const saved = existing
      ? await ProgrammeSyllabus.findOneAndUpdate(
          { programme },
          { pdfUrl, pdfName: nextPdfName },
          { new: true }
        )
      : await ProgrammeSyllabus.create({
          programme,
          pdfUrl,
          pdfName: nextPdfName,
        });

    if (previousPdfUrl && previousPdfUrl !== pdfUrl) {
      const staleId = parseSyllabusPdfId(previousPdfUrl);
      if (staleId) await deleteSyllabusPdf(staleId);
    }

    return NextResponse.json({
      success: true,
      message: existing
        ? "Programme syllabus PDF updated successfully."
        : "Programme syllabus PDF saved successfully.",
      programmeSyllabus: toSafeProgrammeSyllabus(saved!),
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

    console.error("Admin programme syllabus save error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to save programme syllabus." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (programmeSyllabusLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programme = parseProgrammeCode(url.searchParams.get("programme"));

    if (!programme) {
      return NextResponse.json(
        { success: false, message: "A valid programme is required." },
        { status: 400 }
      );
    }

    const existing = await ProgrammeSyllabus.findOne({ programme });

    if (!existing) {
      // Idempotent: nothing attached, nothing to remove.
      return NextResponse.json({
        success: true,
        message: "No programme syllabus PDF was attached.",
      });
    }

    const previousPdfUrl = existing.pdfUrl ?? null;

    // Remove the database reference first, then delete the GridFS bytes.
    await ProgrammeSyllabus.deleteOne({ _id: existing._id });

    if (previousPdfUrl) {
      const staleId = parseSyllabusPdfId(previousPdfUrl);
      if (staleId) await deleteSyllabusPdf(staleId);
    }

    return NextResponse.json({
      success: true,
      message: "Programme syllabus PDF removed successfully.",
    });
  } catch (error) {
    console.error("Admin programme syllabus delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to remove programme syllabus." },
      { status: 500 }
    );
  }
}
