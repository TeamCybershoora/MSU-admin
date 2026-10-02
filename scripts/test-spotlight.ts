/**
 * Offline verification of the Campus-in-the-spotlight upload rules.
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. The upload validation lives in
 * lib/validation.ts as pure functions, so it can be exercised without a
 * database or an HTTP request.
 *
 * Coverage:
 *   1. image-magic-byte sniffing (JPEG / PNG / WebP accepted; others rejected)
 *   2. extension selection per content type
 *   3. safe filename handling (path traversal, unsafe chars, forced extension)
 *   4. size cap sanity
 *
 * Usage: npx tsx scripts/test-spotlight.ts
 */
import {
  IMAGE_MAX_BYTES,
  imageExtensionFor,
  safeImageFilename,
  sniffImageType,
} from "@/lib/validation";
import { toSafeSpotlight } from "@/models/Spotlight";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const SCRIPT = Uint8Array.from([0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e]);

section("Image type is decided by the file signature, not the name");
check("JPEG signature → image/jpeg", sniffImageType(JPEG) === "image/jpeg");
check("PNG signature → image/png", sniffImageType(PNG) === "image/png");
check("WebP signature → image/webp", sniffImageType(WEBP) === "image/webp");
check("PDF bytes → rejected", sniffImageType(PDF) === null);
check("<script> bytes → rejected", sniffImageType(SCRIPT) === null);
check("empty buffer → rejected", sniffImageType(new Uint8Array(0)) === null);

section("Extension follows the verified content type");
check('image/jpeg → "jpg"', imageExtensionFor("image/jpeg") === "jpg");
check('image/png → "png"', imageExtensionFor("image/png") === "png");
check('image/webp → "webp"', imageExtensionFor("image/webp") === "webp");

section("Filenames are sanitised and cannot carry a path");
check(
  "path traversal is stripped",
  safeImageFilename("../../etc/passwd.jpg", "image/jpeg") === "passwd.jpg"
);
check(
  "unsafe characters are removed",
  safeImageFilename('cam<pu>s "shot"!.png', "image/png") === "campus shot.png"
);
check(
  "a mismatched extension is replaced",
  safeImageFilename("photo.png", "image/jpeg") === "photo.jpg"
);
check(
  "an empty name falls back",
  safeImageFilename("", "image/webp") === "spotlight.webp"
);
check(
  "long names are capped",
  safeImageFilename("x".repeat(400), "image/png").length <= 108
);

section("Upload size cap is a sane, non-zero limit");
check(
  "IMAGE_MAX_BYTES is a positive whole number of MB",
  Number.isInteger(IMAGE_MAX_BYTES) && IMAGE_MAX_BYTES > 0
);

section("Admin serializer exposes exactly the fields the UI manages");
const doc = {
  _id: { toString: () => "document-id" },
  imageId: "64b7f0c2a1b2c3d4e5f60718",
  imageName: "campus.png",
  altText: "Students in the main courtyard",
  displayOrder: 10,
  isActive: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as Parameters<typeof toSafeSpotlight>[0];
const out = toSafeSpotlight(doc);
check(
  "exactly the expected keys are present",
  JSON.stringify(Object.keys(out).sort()) ===
    JSON.stringify(
      [
        "altText",
        "createdAt",
        "displayOrder",
        "id",
        "imageId",
        "imageName",
        "isActive",
        "updatedAt",
      ].sort()
    )
);
check("id is stringified", out.id === "document-id");
check("alt text is preserved", out.altText === doc.altText);
check("imageId is preserved for admin editing", out.imageId === doc.imageId);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
