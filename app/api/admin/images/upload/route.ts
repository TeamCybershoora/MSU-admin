/**
 * POST /api/admin/images/upload
 *
 * Shared upload endpoint for ALL admin-managed images (Campus Spotlight,
 * University Leadership, …). Accepts a multipart/form-data request containing a
 * single image ("file"), validates it server-side, stores it in the shared
 * GridFS bucket and returns the id the owning record persists.
 *
 * Responses:
 *   200 { success: true, imageId, imageName, imageUrl } — stored
 *   400 { success: false, message }                     — bad request/empty file
 *   401/403                                             — not an authenticated admin
 *   413 { success: false, message }                     — file too large
 *   415 { success: false, message }                     — not a real image
 *   429 { success: false, message }                     — rate limited
 *   500 { success: false, message }                     — storage failure
 *
 * Security:
 * - Admin JWT required (authenticateAdmin) before any file is touched.
 * - Rate limited per IP (uploads are far heavier than reads).
 * - The MIME type is checked but never trusted: the file signature is verified
 *   on the raw bytes, so scripts renamed to `.jpg` are rejected.
 * - Empty and oversized payloads are rejected before storage.
 * - The stored filename is sanitised and used as metadata only; reads are by
 *   generated ObjectId, so no client value ever reaches a filesystem path.
 */

import { NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  IMAGE_MAX_BYTES,
  safeImageFilename,
  sniffImageType,
} from "@/lib/validation";
import { IMAGE_PATH_PREFIX, saveImage } from "@/lib/image-storage";

export const runtime = "nodejs";

const uploadLimiter = createRateLimiter({
  name: "admin-image-upload",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

/** MIME types browsers legitimately report for image uploads. */
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/octet-stream",
]);

/**
 * Narrow a FormData entry to a file without relying on the global `File`
 * constructor being present in the runtime.
 */
function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).name === "string" &&
    typeof (value as File).size === "number"
  );
}

/**
 * Absolute origin of this request, honouring reverse-proxy headers so a
 * deployed instance records its real public host.
 */
function getRequestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
    url.protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    req.headers.get("host") ||
    url.host;

  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (uploadLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many uploads. Please try again later." },
      { status: 429 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { success: false, message: "Expected a multipart/form-data request." },
      { status: 400 }
    );
  }

  const file = form.get("file");

  if (!isUploadedFile(file)) {
    return NextResponse.json(
      { success: false, message: "No image file was provided." },
      { status: 400 }
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { success: false, message: "The uploaded file is empty." },
      { status: 400 }
    );
  }

  if (file.size > IMAGE_MAX_BYTES) {
    return NextResponse.json(
      {
        success: false,
        message: `Image is too large. Maximum size is ${
          IMAGE_MAX_BYTES / (1024 * 1024)
        } MB.`,
      },
      { status: 413 }
    );
  }

  const declaredType = (file.type || "").toLowerCase();
  if (declaredType && !ALLOWED_MIME_TYPES.has(declaredType)) {
    return NextResponse.json(
      { success: false, message: "Only JPEG, PNG or WebP images are accepted." },
      { status: 415 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Authoritative check — a script renamed to ".jpg" fails here.
  const imageType = sniffImageType(bytes);
  if (!imageType) {
    return NextResponse.json(
      { success: false, message: "Only JPEG, PNG or WebP images are accepted." },
      { status: 415 }
    );
  }

  const imageName = safeImageFilename(file.name, imageType);

  try {
    const id = await saveImage(bytes, imageName, imageType);

    return NextResponse.json({
      success: true,
      message: "Image uploaded successfully.",
      imageId: id,
      imageName,
      imageUrl: `${getRequestOrigin(req)}${IMAGE_PATH_PREFIX}${id}`,
    });
  } catch (error) {
    console.error("Admin image upload error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to store the image. Please try again." },
      { status: 500 }
    );
  }
}
