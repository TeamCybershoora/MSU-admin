/**
 * /api/admin/programme-syllabus
 *
 * Manages the ONE official programme-level syllabus PDF for an academic
 * identity — a programme + academic session (Phase 2A).
 *
 *   GET    ?programme=BCA[&academicSession=2023-24] — list (all / one programme / one identity)
 *   POST   { programme, academicSession, pdfUrl, pdfName } — create/replace
 *   DELETE ?programme=BCA[&academicSession=2023-24] — remove (and its GridFS file)
 *
 * ProgrammeStructure is the source of truth for the programme: the identity is
 * validated against a stored structure before a document is attached, and an
 * INACTIVE structure cannot be selected for a new upload. Omitting
 * `academicSession` addresses a LEGACY session-less document (never a guessed
 * session).
 *
 * Backward compatibility:
 * - No existing syllabus semester/subject record is read, written or deleted here.
 * - Legacy programme documents remain reachable and removable.
 *
 * Security (reuses the established syllabus controls):
 * - Admin JWT required (authenticateAdmin) for every method.
 * - Rate limited per IP.
 * - Only a URL previously issued by POST /api/admin/syllabus/upload is accepted
 *   (validated with parseSyllabusPdfId), never an arbitrary link.
 * - Responses expose only programme + academic session + public PDF URL/name.
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
import { parseAcademicSession } from "@/lib/programme-structure";
import { resolveStructure } from "@/lib/syllabus-academic";
import { deleteSyllabusPdf, parseSyllabusPdfId } from "@/lib/pdf-storage";

export const runtime = "nodejs";

const programmeSyllabusLimiter = createRateLimiter({
  name: "admin-programme-syllabus",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

function fail(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (programmeSyllabusLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programmeParam = url.searchParams.get("programme");
    const sessionParam = url.searchParams.get("academicSession");
    const query: Record<string, unknown> = {};

    if (programmeParam !== null) {
      const programme = parseProgrammeCode(programmeParam);
      if (!programme) return fail("Invalid programme.");
      query.programme = programme;
    }

    if (sessionParam !== null && sessionParam.trim() !== "") {
      const academicSession = parseAcademicSession(sessionParam);
      if (!academicSession) return fail("Invalid academic session.");
      query.academicSession = academicSession;
    }

    const docs = await ProgrammeSyllabus.find(query)
      .sort({ programme: 1, academicSession: 1 })
      .lean();

    return NextResponse.json({
      success: true,
      data: docs.map((doc) => ({
        id: doc._id,
        programme: doc.programme,
        academicSession: doc.academicSession ?? null,
        pdfUrl: doc.pdfUrl ?? null,
        pdfName: doc.pdfName ?? null,
        createdAt: doc.createdAt,
      })),
    });
  } catch (error) {
    console.error("Admin programme syllabus list error:", error);
    return fail("Unable to load programme syllabus.", 500);
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (programmeSyllabusLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  // Captured for a precise duplicate-key message below.
  let conflictProgramme: string | null = null;

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    // Identity must resolve to an ACTIVE structure — a new document is never
    // attached to a historical/inactive curriculum.
    const resolved = await resolveStructure(body.programme, body.academicSession, {
      requireActive: true,
    });
    if (!resolved.ok) return fail(resolved.message, resolved.status);

    const { programmeCode, academicSession } = resolved.data;
    conflictProgramme = programmeCode;

    const { pdfUrl, pdfName } = body;

    // Only references issued by POST /api/admin/syllabus/upload are accepted —
    // an arbitrary URL or filesystem path can never be stored.
    if (typeof pdfUrl !== "string" || !parseSyllabusPdfId(pdfUrl)) {
      return fail("Invalid PDF reference.");
    }

    const nextPdfName =
      typeof pdfName === "string" && pdfName.trim()
        ? safePdfFilename(pdfName)
        : null;

    const existing = await ProgrammeSyllabus.findOne({
      programme: programmeCode,
      academicSession,
    });
    const previousPdfUrl = existing?.pdfUrl ?? null;

    const saved = existing
      ? await ProgrammeSyllabus.findOneAndUpdate(
          { programme: programmeCode, academicSession },
          { pdfUrl, pdfName: nextPdfName },
          { new: true }
        )
      : await ProgrammeSyllabus.create({
          programme: programmeCode,
          academicSession,
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
      code?: number;
      errors?: Record<string, { message: string }>;
    };

    if (err.code === 11000) {
      // A database still carrying the pre-integration `{ programme }` unique
      // index reports a legacy session-less document as the conflict; say so
      // honestly instead of assigning it a session.
      if (conflictProgramme) {
        try {
          const legacy = await ProgrammeSyllabus.findOne({
            programme: conflictProgramme,
            academicSession: null,
          }).select("_id");
          if (legacy) {
            return fail(
              `A legacy session-less programme syllabus document already exists for ${conflictProgramme}. It cannot be mapped to an academic session automatically — a migration must be performed first (no session is ever guessed).`,
              409
            );
          }
        } catch {
          /* legacy collection absent — fall through to the generic message */
        }
      }

      return fail(
        "A programme syllabus document already exists for that programme and academic session.",
        409
      );
    }

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return fail(messages.join(" "));
    }

    console.error("Admin programme syllabus save error:", error);
    return fail("Unable to save programme syllabus.", 500);
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (programmeSyllabusLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programme = parseProgrammeCode(url.searchParams.get("programme"));
    if (!programme) return fail("A valid programme is required.");

    const rawSession = url.searchParams.get("academicSession");
    const sessionProvided = rawSession !== null && rawSession.trim() !== "";
    const academicSession = sessionProvided ? parseAcademicSession(rawSession) : null;
    if (sessionProvided && !academicSession) {
      return fail("Academic session must look like 2023-24.");
    }

    // Omitting the session targets a legacy session-less document.
    const existing = await ProgrammeSyllabus.findOne({
      programme,
      academicSession: academicSession ?? null,
    });

    if (!existing) {
      return NextResponse.json({
        success: true,
        message: "No programme syllabus PDF was attached.",
      });
    }

    const previousPdfUrl = existing.pdfUrl ?? null;

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
    return fail("Unable to remove programme syllabus.", 500);
  }
}
