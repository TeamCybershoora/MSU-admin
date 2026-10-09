/**
 * Syllabus PDF storage (MongoDB GridFS).
 *
 * WHY GRIDFS:
 * The Admin app is deployed to a serverless platform (e.g. Vercel), where the
 * filesystem outside `/tmp` is read-only and ephemeral — a PDF written to disk
 * at runtime would vanish on the next deploy and would not be shared between
 * instances. The repository contains no other persistent file store, so PDFs
 * are kept in the same MongoDB database both apps already share.
 *
 * GridFS is used instead of a plain Buffer field because it streams and has no
 * 16 MB per-document ceiling.
 *
 * Files live in the `syllabusPdfs.files` / `syllabusPdfs.chunks` collections.
 * A syllabus document stores only a URL reference to the file:
 *   https://admin.msu.ac.in/api/syllabus/pdf/<gridfs-id>
 */

import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";

/** GridFS bucket holding syllabus PDFs. */
const BUCKET_NAME = "syllabusPdfs";

/** Public path every stored PDF reference must resolve to. */
export const SYLLABUS_PDF_PATH_PREFIX = "/api/syllabus/pdf/";

/** Matches a 24-character hex ObjectId. */
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** True when `value` is a well-formed MongoDB ObjectId string. */
export function isSyllabusPdfId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value);
}

/**
 * Extract the GridFS id from a stored PDF reference URL, or `null` when the
 * URL does not point at this app's syllabus PDF endpoint.
 *
 * Used to reject arbitrary client-supplied URLs (only references this server
 * issued are accepted) and to locate a superseded file for cleanup.
 */
export function parseSyllabusPdfId(url: string): string | null {
  if (typeof url !== "string" || !url) return null;

  try {
    // Absolute URLs only — a relative reference has no host and is rejected.
    const { pathname } = new URL(url);
    if (!pathname.startsWith(SYLLABUS_PDF_PATH_PREFIX)) return null;

    const id = pathname.slice(SYLLABUS_PDF_PATH_PREFIX.length);
    return isSyllabusPdfId(id) ? id : null;
  } catch {
    return null;
  }
}

function getBucket(): mongoose.mongo.GridFSBucket {
  const db = mongoose.connection.db;

  if (!db) {
    throw new Error("MongoDB connection is not established.");
  }

  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
}

/**
 * Store a PDF in GridFS. Returns the new GridFS file id.
 *
 * `filename` is metadata for display only — reads are always performed by id,
 * so a malicious name can never influence a filesystem path.
 */
export async function saveSyllabusPdf(
  data: Buffer,
  filename: string
): Promise<string> {
  await connectDB();
  const bucket = getBucket();

  const upload = bucket.openUploadStream(filename, {
    contentType: "application/pdf",
  });

  await new Promise<void>((resolve, reject) => {
    upload.on("error", reject);
    upload.on("finish", () => resolve());
    upload.end(data);
  });

  return upload.id.toString();
}

/**
 * Read a PDF back out of GridFS.
 *
 * Returns `null` when no such file exists (e.g. an already-replaced or deleted
 * reference), so callers can respond with a clean 404.
 */
export async function readSyllabusPdf(
  id: string
): Promise<{ data: Buffer; filename: string } | null> {
  if (!isSyllabusPdfId(id)) return null;

  await connectDB();
  const bucket = getBucket();
  const objectId = new mongoose.Types.ObjectId(id);

  const [info] = await bucket.find({ _id: objectId }).limit(1).toArray();
  if (!info) return null;

  const chunks: Buffer[] = [];
  const download = bucket.openDownloadStream(objectId);

  await new Promise<void>((resolve, reject) => {
    download.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    download.on("error", reject);
    download.on("end", () => resolve());
  });

  return {
    data: Buffer.concat(chunks),
    filename: typeof info.filename === "string" ? info.filename : "syllabus.pdf",
  };
}

/**
 * Delete a stored PDF. Best-effort: a missing file is not an error, because the
 * goal is simply that no orphaned bytes remain after a replace or clear.
 */
export async function deleteSyllabusPdf(id: string): Promise<void> {
  if (!isSyllabusPdfId(id)) return;

  await connectDB();
  const bucket = getBucket();

  try {
    await bucket.delete(new mongoose.Types.ObjectId(id));
  } catch {
    // Already gone, or never existed — nothing to clean up.
  }
}
