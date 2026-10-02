/**
 * Offline verification of the admin Notice serialization + featured-image URL
 * handling used by the Latest News feature.
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. `toSafeNotice` is a pure
 * function, so the shape can be checked without a database.
 *
 * Coverage:
 *   1. only the public-safe fields are exposed (no _id / isDeleted / timestamps)
 *   2. the featured image serializes to a public URL (or "" when absent)
 *   3. news is a valid content type
 *   4. publishedDate is serialized as an ISO string
 *
 * Usage: npx tsx scripts/test-notices.ts
 */
import { toSafeNotice, noticeImageUrl } from "@/models/Notice";
import { VALID_CONTENT_TYPES } from "@/lib/notice-types";

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

const IMAGE_ID = "64b7f0c2a1b2c3d4e5f60718";

const doc = {
  _id: { toString: () => "document-id" },
  title: "MSU Students Win National Hackathon",
  summary: "A team of four students won the national-level hackathon.",
  content: "Full story body.",
  category: "Academic",
  contentType: "news",
  publishedDate: new Date("2026-08-10T00:00:00.000Z"),
  isNewNotice: true,
  isImportant: false,
  status: "published",
  attachmentName: "",
  attachmentUrl: "",
  imageId: IMAGE_ID,
  imageName: "hackathon.jpg",
  imageAlt: "Students receiving the hackathon trophy",
  isDeleted: false,
} as unknown as Parameters<typeof toSafeNotice>[0];

const out = toSafeNotice(doc);

const EXPECTED_KEYS = [
  "attachmentName",
  "attachmentUrl",
  "category",
  "content",
  "contentType",
  "id",
  "imageAlt",
  "imageUrl",
  "isImportant",
  "isNew",
  "publishedDate",
  "status",
  "summary",
  "title",
].sort();

section("Admin serializer exposes only the intended fields");
check(
  "exactly the expected keys are present",
  JSON.stringify(Object.keys(out).sort()) === JSON.stringify(EXPECTED_KEYS)
);
check("no _id is exposed", !("_id" in out));
check("no isDeleted is exposed", !("isDeleted" in out));
check("no imageId is exposed", !("imageId" in out));
check("no imageName is exposed", !("imageName" in out));

section("Featured image maps to the public image route");
check("imageUrl points at the public image route", out.imageUrl === `/api/images/${IMAGE_ID}`);
check("imageAlt is preserved", out.imageAlt === "Students receiving the hackathon trophy");
check("noticeImageUrl builds the public path", noticeImageUrl(IMAGE_ID) === `/api/images/${IMAGE_ID}`);
check("noticeImageUrl returns empty for no image", noticeImageUrl("") === "");

section("A notice with no image serializes to an empty imageUrl");
const noImage = toSafeNotice({
  ...doc,
  imageId: "",
} as unknown as Parameters<typeof toSafeNotice>[0]);
check("imageUrl is empty without an image", noImage.imageUrl === "");

section("News is a valid content type");
check("VALID_CONTENT_TYPES includes 'news'", VALID_CONTENT_TYPES.includes("news"));
check("publishedDate is ISO serialized", out.publishedDate === "2026-08-10T00:00:00.000Z");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
