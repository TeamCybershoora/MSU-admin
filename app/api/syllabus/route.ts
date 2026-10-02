/**
 * GET /api/syllabus — PUBLIC, read-only syllabus lookup.
 *
 * Resolves the syllabus for exactly one academic identity:
 *
 *   ?programmeCode=BCA&academicSession=2023-24&semester=1
 *
 * `academicSession` is REQUIRED: it is part of the syllabus identity, so the
 * endpoint can never fall back to "any session". All parameters are validated
 * server-side in lib/public-syllabus.ts (400 malformed, 404 unknown identity).
 *
 * Responses:
 *   200 { success: true, data: { programme, semesters, semester, syllabus,
 *                                programmeDocument, legacyDocumentWithheld } }
 *   400 { success: false, message } — malformed query parameter
 *   404 { success: false, message } — unknown programme/session/semester
 *   500 { success: false, message } — unexpected failure (no internals leaked)
 *
 * Security: GET only — no public writes. The admin API
 * (/api/admin/academic-structure and the admin syllabus routes) is never
 * reachable through this handler.
 */

import { NextResponse } from "next/server";
import { getPublicSyllabus } from "@/lib/public-syllabus";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    const result = await getPublicSyllabus({
      programmeCode: url.searchParams.get("programmeCode"),
      academicSession: url.searchParams.get("academicSession"),
      semester: url.searchParams.get("semester"),
    });

    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status }
      );
    }

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    // Logged server-side only; the response never carries stack traces,
    // collection names or driver errors.
    console.error("Public syllabus lookup error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load the syllabus." },
      { status: 500 }
    );
  }
}
