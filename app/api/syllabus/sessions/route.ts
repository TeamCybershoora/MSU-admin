/**
 * GET /api/syllabus/sessions?programmeCode=BCA — PUBLIC, read-only session
 * discovery.
 *
 * Returns ONLY the academic sessions that actually exist for the programme,
 * derived from stored ProgrammeStructure data. No session is ever hardcoded or
 * invented: if the database holds BCA 2023-24 and nothing else, the response
 * is exactly [2023-24].
 *
 * Responses:
 *   200 { success: true, data: [{ academicSession, status }] } — may be empty
 *   400 { success: false, message } — malformed programmeCode
 *   500 { success: false, message }
 *
 * Security: GET only — no public writes, no admin API exposure.
 */

import { NextResponse } from "next/server";
import { listPublicSessions } from "@/lib/public-syllabus";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    const result = await listPublicSessions(
      url.searchParams.get("programmeCode")
    );

    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status }
      );
    }

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    console.error("Public syllabus sessions error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load academic sessions." },
      { status: 500 }
    );
  }
}
