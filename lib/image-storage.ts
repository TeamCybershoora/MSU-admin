/**
 * Shared site image storage (MongoDB GridFS).
 *
 * Used for ALL admin-managed images — Campus Spotlight and University
 * Leadership — from ONE bucket, so the two features never spin up competing
 * storage. A document stores only the GridFS id; both MSU apps serve it at the
 * same public path: /api/images/<gridfs-id>.
 *
 * WHY GRIDFS:
 * This app is deployed to a serverless platform, where the filesystem outside
 * `/tmp` is read-only and ephemeral — an image written to disk would vanish on
 * the next deploy and would not be shared between instances. The project
 * already uses MongoDB GridFS for uploaded PDFs (lib/pdf-storage.ts); this
 * module reuses the SAME mechanism, with its own bucket so images and PDFs do
 * not mix.
 *
 * The bucket was originally named "spotlightImages". It is now shared, so files
 * are written to "siteImages"; reads fall back to the legacy bucket name so any
 * image stored before the rename keeps working.
 */

import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";

/** GridFS bucket holding all site images. */
const BUCKET_NAME = "siteImages";

/** Previous bucket name — read/delete fallback for pre-existing files. */
const LEGACY_BUCKET_NAMES = ["spotlightImages"] as const;

/** Public path every stored image reference must resolve to. */
export const IMAGE_PATH_PREFIX = "/api/images/";

/** Matches a 24-character hex ObjectId. */
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** True when `value` is a well-formed MongoDB ObjectId string. */
export function isImageId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value);
}

function getBucket(bucketName: string = BUCKET_NAME): mongoose.mongo.GridFSBucket {
  const db = mongoose.connection.db;

  if (!db) {
    throw new Error("MongoDB connection is not established.");
  }

  return new mongoose.mongo.GridFSBucket(db, { bucketName });
}

/**
 * Store an image in GridFS. Returns the new GridFS file id.
 *
 * `filename` is display metadata only — reads are always performed by id, so a
 * malicious name can never influence a filesystem path. `contentType` has
 * already been verified from the file signature by the caller.
 */
export async function saveImage(
  data: Buffer,
  filename: string,
  contentType: string
): Promise<string> {
  await connectDB();
  const bucket = getBucket();

  const upload = bucket.openUploadStream(filename, { contentType });

  await new Promise<void>((resolve, reject) => {
    upload.on("error", reject);
    upload.on("finish", () => resolve());
    upload.end(data);
  });

  return upload.id.toString();
}

async function readFromBucket(
  id: string,
  bucketName: string
): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  const bucket = getBucket(bucketName);
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

  const contentType =
    typeof info.contentType === "string" && info.contentType
      ? info.contentType
      : "application/octet-stream";

  return {
    data: Buffer.concat(chunks),
    filename: typeof info.filename === "string" ? info.filename : "image",
    contentType,
  };
}

/**
 * Read an image back out of GridFS.
 *
 * Returns `null` when no such file exists (e.g. an already-replaced or deleted
 * reference), so callers can respond with a clean 404. Checks the current
 * bucket first, then the legacy bucket name.
 */
export async function readImage(
  id: string
): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  if (!isImageId(id)) return null;

  await connectDB();

  for (const bucketName of [BUCKET_NAME, ...LEGACY_BUCKET_NAMES]) {
    const file = await readFromBucket(id, bucketName);
    if (file) return file;
  }

  return null;
}

/**
 * Delete a stored image. Best-effort: a missing file is not an error, because
 * the goal is simply that no orphaned bytes remain after a replace or delete.
 * Removes from every known bucket so legacy files are cleaned up too.
 */
export async function deleteImage(id: string): Promise<void> {
  if (!isImageId(id)) return;

  await connectDB();
  const objectId = new mongoose.Types.ObjectId(id);

  for (const bucketName of [BUCKET_NAME, ...LEGACY_BUCKET_NAMES]) {
    try {
      await getBucket(bucketName).delete(objectId);
    } catch {
      // Already gone, or never existed in this bucket — nothing to clean up.
    }
  }
}
