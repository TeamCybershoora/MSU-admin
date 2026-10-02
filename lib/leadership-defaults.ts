/**
 * Default University Leadership content — the SINGLE source of truth for the
 * admin "Restore Default" action.
 *
 * These are the two people that were hardcoded on the public homepage before
 * leadership became admin-managed and are still the values used by the public
 * app's one-off `scripts/seed-leadership.ts`. Keeping them here (server-only)
 * means Restore Default never trusts a browser-supplied object and the defaults
 * are not duplicated across admin components.
 *
 * The default photograph for each role ships with the admin app in
 * `public/leadership-defaults/`. Restore Default reads it from disk and stores
 * it in the SHARED GridFS bucket through lib/image-storage.ts — the same
 * pipeline every other upload uses, so no new bucket or upload utility exists.
 * `next.config.ts` traces these files into the restore route for serverless
 * deployments.
 */

import fs from "node:fs";
import path from "node:path";
import { type LeadershipRole } from "@/lib/leadership";
import { safeImageFilename, sniffImageType } from "@/lib/validation";

export interface LeadershipDefault {
  role: LeadershipRole;
  name: string;
  designation: string;
  description: string;
  altText: string;
  displayOrder: number;
  /** Filename under public/leadership-defaults/ holding the default photo. */
  imageFile: string;
}

export const LEADERSHIP_DEFAULTS: Record<LeadershipRole, LeadershipDefault> = {
  chancellor: {
    role: "chancellor",
    name: "Smt. Anandiben Patel",
    designation: "Hon'ble Chancellor",
    description:
      "The Chancellor is the ceremonial head of the university and presides over convocations and major academic events.",
    altText: "Portrait of Smt. Anandiben Patel, Chancellor",
    displayOrder: 10,
    imageFile: "chancellor.png",
  },
  "vice-chancellor": {
    role: "vice-chancellor",
    name: "Prof. Vimala Y.",
    designation: "Vice Chancellor",
    description:
      "The Vice Chancellor is the chief executive and academic officer responsible for the day-to-day administration of the university.",
    altText: "Portrait of Prof. Vimala Y., Vice Chancellor",
    displayOrder: 20,
    imageFile: "vice-chancellor.jpg",
  },
};

/**
 * Read a role's default photograph from disk.
 *
 * Returns the raw bytes plus a signature-verified content type and a sanitised
 * filename, ready for `saveImage`. Returns `null` when the file is missing or
 * is not a supported image, so the caller can fail cleanly instead of storing
 * an unverified file.
 */
export function readLeadershipDefaultImage(
  role: LeadershipRole
): { data: Buffer; filename: string; contentType: string } | null {
  const { imageFile } = LEADERSHIP_DEFAULTS[role];
  // Literal path segments keep the read statically scoped so the bundler does
  // not trace the whole project (and so these files are always included).
  const abs = path.join(process.cwd(), "public", "leadership-defaults", imageFile);
  if (!fs.existsSync(abs)) return null;

  const data = fs.readFileSync(abs);
  const contentType = sniffImageType(data);
  if (!contentType) return null;

  return {
    data,
    filename: safeImageFilename(imageFile, contentType),
    contentType,
  };
}
