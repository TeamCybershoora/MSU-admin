/**
 * POST /api/admin/syllabus/upload
 *
 * Accepts a multipart/form-data request containing a single PDF ("file"),
 * validates it server-side, stores it in GridFS and returns a public URL
 * reference that the syllabus create/update route persists on the record.
 *
 * Responses:
 *   200 { success: true, pdfUrl, pdfName }                     — stored
 *   400 { success: false, message }                            — bad request/empty file
 *   401/403                                                    — not an authenticated admin
 *   413 { success: false, message }                            — file too large
 *   415 { success: false, message }                            — not a real PDF
 *   429 { success: false, message }                            — rate limited
 *   500 { success: false, message }                            — storage failure
 *
 * Security:
 * - Admin JWT required (authenticateAdmin) before any file is touched.
 * - Rate limited per IP (uploads are far heavier than reads).
 * - The MIME type is checked but never trusted: the `%PDF-` signature is
 *   verified on the raw bytes, so images/scripts renamed to `.pdf` are rejected.
 * - Empty and oversized payloads are rejected before storage.
 * - The stored filename is sanitised and used as metadata only; reads are by
 *   generated ObjectId, so no client value ever reaches a filesystem path.
 * - Only a public URL is returned — never an internal path or storage id.
 */

import { NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  PDF_MAX_BYTES,
  isPdfBuffer,
  safePdfFilename,
} from "@/lib/validation";
import { SYLLABUS_PDF_PATH_PREFIX, saveSyllabusPdf } from "@/lib/pdf-storage";

export const runtime = "nodejs";

const uploadLimiter = createRateLimiter({
  name: "admin-syllabus-upload",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

/** MIME types browsers legitimately report for PDF uploads. */
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
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
 * Absolute origin of this request.
 *
 * Honours the reverse-proxy headers so a deployed instance behind a proxy
 * records its real public host (e.g. https://admin.msu.ac.in) rather than the
 * internal one. This matters because the reference is consumed cross-origin by
 * the public MSU site.
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
      { success: false, message: "No PDF file was provided." },
      { status: 400 }
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { success: false, message: "The uploaded file is empty." },
      { status: 400 }
    );
  }

  if (file.size > PDF_MAX_BYTES) {
    return NextResponse.json(
      {
        success: false,
        message: `PDF is too large. Maximum size is ${
          PDF_MAX_BYTES / (1024 * 1024)
        } MB.`,
      },
      { status: 413 }
    );
  }

  const declaredType = (file.type || "").toLowerCase();
  if (declaredType && !ALLOWED_MIME_TYPES.has(declaredType)) {
    return NextResponse.json(
      { success: false, message: "Only PDF files are accepted." },
      { status: 415 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Authoritative check — a PNG/JPG/script renamed to ".pdf" fails here.
  if (!isPdfBuffer(bytes)) {
    return NextResponse.json(
      { success: false, message: "Only PDF files are accepted." },
      { status: 415 }
    );
  }

  const pdfName = safePdfFilename(file.name);

  try {
    const id = await saveSyllabusPdf(bytes, pdfName);

    return NextResponse.json({
      success: true,
      message: "PDF uploaded successfully.",
      pdfUrl: `${getRequestOrigin(req)}${SYLLABUS_PDF_PATH_PREFIX}${id}`,
      pdfName,
    });
  } catch (error) {
    console.error("Admin syllabus PDF upload error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to store the PDF. Please try again." },
      { status: 500 }
    );
  }
}
