/**
 * Legacy homepage photo import — one-off, idempotent, NON-DESTRUCTIVE.
 *
 * The original MSU homepage carousel had 23 hard-coded photos (public/news/*
 * .jpeg) declared in the old lib/home-data.ts as `newsItems`. When the
 * homepage was changed to fetch from the database those photos dropped off the
 * page. This script recovers them into the NEW News collection.
 *
 * What was recoverable (from git history, lib/home-data.ts):
 *   - the image file,
 *   - its original carousel ORDER,
 *   - the publication DATE (both from the image filename's Unix timestamp and
 *     from the original caption "University news · DD Mon YYYY").
 *
 * What was NOT recoverable: a real title, heading or body. The old carousel
 * associated NO text other than that generic dated caption, so each imported
 * record uses the EXACT recovered caption as its title. Nothing is invented.
 * An admin can later edit any record to give it a real title/summary.
 *
 * Safety guarantees:
 *   - Nothing is deleted or overwritten.
 *   - Idempotent: records are keyed by `sourceImagePath` (unique, sparse) and
 *     an existing import is skipped, so re-running creates no duplicates.
 *   - Images go through the SAME secure pipeline as every other admin image:
 *     magic-byte sniffing (lib/validation sniffImageType) and filename
 *     sanitisation, stored in the shared "siteImages" GridFS bucket.
 *   - `--dry-run` performs every check and reports what WOULD happen without
 *     writing to MongoDB.
 *
 * Usage (run from the msu-admin project root):
 *   # preview only (safe):
 *   npx tsx scripts/migrate-legacy-news.ts --dry-run
 *   # apply:
 *   npx tsx scripts/migrate-legacy-news.ts
 *   # if the public site lives elsewhere:
 *   npx tsx scripts/migrate-legacy-news.ts --source="D:/path/to/msu/public/news"
 *
 * This script is NOT executed automatically. Running it is a deliberate,
 * reversible admin action.
 */

// Standalone scripts run under plain `tsx`, which (unlike `next dev`/`next build`)
// does not load Next.js environment files. Load the project's existing
// `.env.local` explicitly, using the same pattern as the other admin scripts
// (scripts/create-admin.ts, scripts/seed-bca-2023-24.ts, …). `quiet: true`
// suppresses dotenv's own output so no environment content is ever logged.
// (lib/mongodb reads MONGODB_URI lazily inside connectDB(), which runs after
// this module body has populated process.env.)
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

import fs from "node:fs";
import path from "node:path";
import connectDB from "../lib/mongodb";
import News from "../models/News";
import { saveImage } from "../lib/image-storage";
import { safeImageFilename, sniffImageType } from "../lib/validation";

interface LegacyPhoto {
  /** File name inside public/news/. */
  file: string;
  /** Exact recovered caption — the only text the old carousel ever had. */
  caption: string;
}

/**
 * The 23 original homepage photos in their ORIGINAL carousel order, recovered
 * from git history (lib/home-data.ts @ HEAD before it was removed).
 */
const LEGACY_PHOTOS: LegacyPhoto[] = [
  { file: "1784787477_8497214e7cca3599d1fa.jpeg", caption: "University news · 23 Jul 2026" },
  { file: "1784787524_e9c503f1cbbfed362219.jpeg", caption: "University news · 23 Jul 2026" },
  { file: "1784787540_01b236f20d6e6ffe78e9.jpeg", caption: "University news · 23 Jul 2026" },
  { file: "1784787563_2257af60763fb2c64595.jpeg", caption: "University news · 23 Jul 2026" },
  { file: "1784790541_e5938e7f72f0cd863169.jpeg", caption: "University news · 23 Jul 2026" },
  { file: "1784790549_e63360bc393c2bba43ec.jpeg", caption: "University news · 23 Jul 2026" },
  { file: "1784790556_0c1dcc5c3d1e3a8ba42c.jpeg", caption: "University news · 23 Jul 2026" },
  { file: "1784991281_b866edf7ae3083865bf3.jpeg", caption: "University news · 25 Jul 2026" },
  { file: "1784991287_829c362ec8d29037221e.jpeg", caption: "University news · 25 Jul 2026" },
  { file: "1784991293_816bf24c7d6d9989a6e4.jpeg", caption: "University news · 25 Jul 2026" },
  { file: "1784991299_fe78c19f0f60d358cecb.jpeg", caption: "University news · 25 Jul 2026" },
  { file: "1785137622_1c2944432a71e1d39f7a.jpeg", caption: "University news · 27 Jul 2026" },
  { file: "1785137659_bf307a96b8f60119a041.jpeg", caption: "University news · 27 Jul 2026" },
  { file: "1785137699_587d34da1608b5431f06.jpeg", caption: "University news · 27 Jul 2026" },
  { file: "1785137721_4db1e37c85265119f6c2.jpeg", caption: "University news · 27 Jul 2026" },
  { file: "1785137752_50354df9554a21e0a1f2.jpeg", caption: "University news · 27 Jul 2026" },
  { file: "1785238339_becee92aeb76392ab492.jpeg", caption: "University news · 28 Jul 2026" },
  { file: "1785238364_d769aa61c6be42d2a189.jpeg", caption: "University news · 28 Jul 2026" },
  { file: "1785303065_f97effaa262b0548734a.jpeg", caption: "University news · 29 Jul 2026" },
  { file: "1785303092_b8987b30d14ebd26d15e.jpeg", caption: "University news · 29 Jul 2026" },
  { file: "1785303119_b86268fed47fd4f49d32.jpeg", caption: "University news · 29 Jul 2026" },
  { file: "1785568509_7205a44cedebfbc16b38.jpeg", caption: "University news · 01 Aug 2026" },
  { file: "1785568531_9f65f23cf598fb03644a.jpeg", caption: "University news · 01 Aug 2026" },
];

/** Original public path — the idempotency key for an imported photo. */
function sourceImagePath(file: string): string {
  return `/news/${file}`;
}

/** Publication date = the image's own upload timestamp (leading Unix seconds). */
function dateFromFilename(file: string, fallbackCaption: string): Date {
  const match = /^(\d{10})_/.exec(file);
  const relative = match ? new Date(Number(match[1]) * 1000) : null;
  if (relative && !Number.isNaN(relative.getTime())) return relative;

  // Fall back to the caption date ("... · 23 Jul 2026") if the name is odd.
  const captionDate = /·\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/.exec(fallbackCaption);
  const parsed = captionDate ? new Date(captionDate[1]) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

interface Options {
  sourceDir: string;
  dryRun: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const sourceArg = args.find((a) => a.startsWith("--source="));
  const sourceDir = sourceArg
    ? sourceArg.slice("--source=".length)
    : path.resolve(process.cwd(), "..", "..", "msu", "public", "news");

  return {
    sourceDir,
    dryRun: args.includes("--dry-run"),
  };
}

async function main() {
  const { sourceDir, dryRun } = parseArgs();

  console.log(`Legacy News import ${dryRun ? "(DRY RUN — no writes)" : ""}`);
  console.log(`Source directory: ${sourceDir}\n`);

  if (!fs.existsSync(sourceDir)) {
    console.error(
      `Source directory not found: ${sourceDir}\n` +
        `Pass the folder that holds the original public/news/*.jpeg files ` +
        `with --source="<path>".`
    );
    process.exit(1);
  }

  await connectDB();

  let created = 0;
  let skipped = 0;
  let missing = 0;
  let invalid = 0;

  for (let i = 0; i < LEGACY_PHOTOS.length; i += 1) {
    const photo = LEGACY_PHOTOS[i];
    const key = sourceImagePath(photo.file);
    const fullPath = path.join(sourceDir, photo.file);

    // Idempotency: a previous run already imported this exact photo.
    const existing = await News.findOne({ sourceImagePath: key }).lean();
    if (existing) {
      console.log(`  SKIP   ${photo.file} — already imported`);
      skipped += 1;
      continue;
    }

    if (!fs.existsSync(fullPath)) {
      console.warn(`  MISS   ${photo.file} — file not found in source directory`);
      missing += 1;
      continue;
    }

    const bytes = fs.readFileSync(fullPath);
    const imageType = sniffImageType(bytes);
    if (!imageType) {
      console.warn(`  BAD    ${photo.file} — not a JPEG/PNG/WebP image (signature check)`);
      invalid += 1;
      continue;
    }

    const publishedDate = dateFromFilename(photo.file, photo.caption);

    if (dryRun) {
      console.log(
        `  WOULD  ${photo.file} → title="${photo.caption}" date=${publishedDate
          .toISOString()
          .slice(0, 10)} order=${i}`
      );
      created += 1;
      continue;
    }

    const imageId = await saveImage(
      bytes,
      safeImageFilename(photo.file, imageType),
      imageType
    );

    await News.create({
      title: photo.caption,
      summary: "",
      content: "",
      imageId,
      imageName: safeImageFilename(photo.file, imageType),
      imageAlt: photo.caption,
      publishedDate,
      status: "published",
      displayOrder: i,
      sourceImagePath: key,
    });

    console.log(`  OK     ${photo.file} → imported (order ${i})`);
    created += 1;
  }

  console.log(
    `\n${created} ${dryRun ? "would be imported" : "imported"}, ` +
      `${skipped} skipped (already present), ` +
      `${missing} missing, ${invalid} invalid.`
  );

  if (!dryRun && created > 0) {
    console.log(
      "\nThese photos are published, so the homepage Latest News carousel now " +
        "shows the newest of them. Edit each record in /admin/news to add a " +
        "real title/summary when the faculty supplies one."
    );
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Legacy News import failed:", error);
  process.exit(1);
});
