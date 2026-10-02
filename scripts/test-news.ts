/**
 * Offline verification of the News system's pure logic.
 *
 * Never connects to MongoDB, never reads an environment value and writes
 * nothing — it only exercises the exported serializers and constants, so it
 * runs anywhere.
 *
 * Coverage:
 *   1. News statuses are exactly draft/published
 *   2. newsImageUrl() maps an image id to the shared public image path
 *   3. toSafeNews() exposes exactly the admin fields (including imageId/imageName
 *      so the edit form can replace an image without losing it)
 *   4. News records never expose internal fields (isDeleted, sourceImagePath)
 *
 * Usage: npx tsx scripts/test-news.ts
 */
import { NEWS_STATUSES } from "@/lib/news-types";
import News, { newsImageUrl, toSafeNews } from "@/models/News";

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

section("News statuses are exactly draft/published");
check("two statuses", NEWS_STATUSES.length === 2);
check('includes "draft"', NEWS_STATUSES.includes("draft"));
check('includes "published"', NEWS_STATUSES.includes("published"));

section("Featured image resolves to the shared public image path");
const IMAGE_ID = "64b7f0c2a1b2c3d4e5f60718";
check(
  "image id → /api/images/<id>",
  newsImageUrl(IMAGE_ID) === `/api/images/${IMAGE_ID}`
);
check("no image → empty string", newsImageUrl("") === "");

section("Admin serializer exposes exactly the managed fields");
const doc = {
  _id: { toString: () => "news-id" },
  title: "MSU students win national hackathon",
  summary: "A short heading",
  content: "Full body copy",
  imageId: IMAGE_ID,
  imageName: "campus.jpg",
  imageAlt: "Students on stage",
  publishedDate: new Date("2026-08-10T00:00:00.000Z"),
  status: "published",
  displayOrder: 3,
  sourceImagePath: "/news/legacy.jpeg",
  isDeleted: false,
} as unknown as Parameters<typeof toSafeNews>[0];
const out = toSafeNews(doc);

check("id is stringified", out.id === "news-id");
check("title preserved", out.title === doc.title);
check("summary preserved", out.summary === doc.summary);
check("content preserved", out.content === doc.content);
check("publishedDate is ISO", out.publishedDate === "2026-08-10T00:00:00.000Z");
check("status preserved", out.status === "published");
check("imageId preserved (edit can replace the image)", out.imageId === IMAGE_ID);
check("imageName preserved (admin metadata)", out.imageName === "campus.jpg");
check("imageAlt preserved", out.imageAlt === "Students on stage");
check("imageUrl derived from imageId", out.imageUrl === `/api/images/${IMAGE_ID}`);
check(
  "exactly the expected keys are present",
  JSON.stringify(Object.keys(out).sort()) ===
    JSON.stringify(
      [
        "content",
        "id",
        "imageAlt",
        "imageId",
        "imageName",
        "imageUrl",
        "publishedDate",
        "status",
        "summary",
        "title",
      ].sort()
    )
);
check("internal isDeleted is NOT exposed", !("isDeleted" in out));
check("internal sourceImagePath is NOT exposed", !("sourceImagePath" in out));

section("Model is registered under the dedicated News collection name");
check("mongoose model name is News", News.modelName === "News");
check("collection is not Notice", News.collection.name !== "notices");

section("Blank optional fields serialize as empty strings (never undefined)");
const minimal = toSafeNews({
  _id: { toString: () => "n2" },
  title: "Title only",
  summary: "",
  content: "",
  imageId: "",
  imageName: "",
  imageAlt: "",
  publishedDate: new Date("2026-01-01T00:00:00.000Z"),
  status: "draft",
} as unknown as Parameters<typeof toSafeNews>[0]);
check("summary is \"\"", minimal.summary === "");
check("imageUrl is \"\"", minimal.imageUrl === "");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
