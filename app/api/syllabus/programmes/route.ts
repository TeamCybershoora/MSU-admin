/**
 * GET /api/syllabus/programmes — PUBLIC, read-only programme discovery.
 *
 * Returns the programmes the public syllabus UI can offer, derived from
 * stored data only (ProgrammeStructure plus legacy syllabus-only codes).
 * Nothing is hardcoded and no status is filtered: historical programmes and
 * sessions must stay reachable, and legacy documents have no status field.
 *
 * Responses:
 *   200 { success: true, data: [{ programmeCode, programmeName }] }
 *   500 { success: false, message }
 *
 * Security: GET only — no public writes, no admin API exposure.
 */

import { NextResponse } from "next/server";
import { listPublicProgrammes } from "@/lib/public-syllabus";

export const runtime = "nodejs";

export async function GET() {
  try {
    const result = await listPublicProgrammes();

    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status }
      );
    }

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    console.error("Public syllabus programmes error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load programmes." },
      { status: 500 }
    );
  }
}
