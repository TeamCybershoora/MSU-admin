/**
 * GET /api/images/[id]
 *
 * Serves any admin-managed site image (Campus Spotlight, University
 * Leadership, …) by its GridFS id, from the shared `siteImages` bucket.
 *
 * This route is intentionally PUBLIC (no admin token): the ids are referenced
 * by the public MSU website, which cannot present an admin JWT. Access is by
 * unguessable ObjectId and the payload is immutable once written.
 *
 * Responses:
 *   200 <image> — the file
 *   404 { success: false, message } — no such file (deleted or replaced)
 *   500 { success: false, message } — storage failure
 *
 * Security:
 * - Only a 24-hex ObjectId is accepted, so nothing from the path can reach a
 *   filesystem or a database operator.
 * - Content-Type is limited to images and `nosniff` is set, so stored bytes can
 *   never be interpreted as HTML/script by a browser.
 * - No internal storage paths or credentials are ever returned.
 */

import { NextResponse } from "next/server";
import { readImage } from "@/lib/image-storage";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const file = await readImage(id);

    if (!file) {
      return NextResponse.json(
        { success: false, message: "Image not found." },
        { status: 404 }
      );
    }

    return new Response(new Uint8Array(file.data), {
      status: 200,
      headers: {
        "Content-Type": file.contentType.startsWith("image/")
          ? file.contentType
          : "application/octet-stream",
        "Content-Length": String(file.data.length),
        "X-Content-Type-Options": "nosniff",
        // Content is immutable: a replacement gets a brand new id.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Public image read error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load the image." },
      { status: 500 }
    );
  }
}
