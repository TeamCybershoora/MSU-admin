/**
 * GET /api/syllabus/pdf/[id]
 *
 * Serves a stored syllabus PDF by its GridFS id.
 *
 * This route is intentionally PUBLIC (no admin token): the URL is stored on the
 * syllabus record and is consumed cross-origin by the public MSU website
 * (https://msu.ac.in), which cannot present an admin JWT. Access is by
 * unguessable ObjectId and the payload is immutable once written.
 *
 * Responses:
 *   200 application/pdf — the file
 *   400 { success: false, message } — malformed id
 *   404 { success: false, message } — no such file
 *   500 { success: false, message } — storage failure
 *
 * Optional query parameter:
 *   ?download=1 — send the file as an attachment, so the public "Download"
 *   button saves it instead of opening it inline. Default (no parameter) is
 *   unchanged: inline, identical to the original behaviour.
 *
 * Security:
 * - Only a 24-hex ObjectId is accepted, so nothing from the path can reach a
 *   filesystem or a database operator.
 * - Content-Type is forced to application/pdf and `nosniff` is set, so stored
 *   bytes can never be interpreted as HTML/script by a browser.
 * - No internal storage paths, ids beyond the one requested, or credentials are
 *   ever returned.
 */

import { NextResponse } from "next/server";
import { readSyllabusPdf } from "@/lib/pdf-storage";
import { headerSafeFilename } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Opt-in download; anything other than "1" keeps the original inline view.
  const asAttachment =
    new URL(req.url).searchParams.get("download") === "1";

  try {
    const file = await readSyllabusPdf(id);

    if (!file) {
      return NextResponse.json(
        { success: false, message: "PDF not found." },
        { status: 404 }
      );
    }

    return new Response(new Uint8Array(file.data), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.data.length),
        "Content-Disposition": `${
          asAttachment ? "attachment" : "inline"
        }; filename="${headerSafeFilename(file.filename)}"`,
        "X-Content-Type-Options": "nosniff",
        // Content is immutable: a replacement gets a brand new id.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Public syllabus PDF read error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load the PDF." },
      { status: 500 }
    );
  }
}
