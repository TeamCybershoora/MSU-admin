/**
 * Offline verification of the FIXED University Leadership rules.
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. The rules live in
 * lib/leadership.ts, lib/leadership-defaults.ts and the model serializer as
 * pure/offline-safe code.
 *
 * Coverage:
 *   1. the only accepted roles are the fixed positions (accept known, reject everything else)
 *   2. every fixed position has a label
 *   3. every position has a complete default (name/designation/description/alt)
 *   4. each default photograph exists on disk and is a supported image
 *   5. the admin serializer exposes the expected fields and NEVER a profile URL
 *   6. a legacy document that still carries `profileUrl` does not leak it
 *
 * Usage: npx tsx scripts/test-leadership.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  LEADERSHIP_ROLES,
  LEADERSHIP_ROLE_LABELS,
  isLeadershipRole,
} from "@/lib/leadership";
import {
  LEADERSHIP_DEFAULTS,
  readLeadershipDefaultImage,
} from "@/lib/leadership-defaults";
import { sniffImageType } from "@/lib/validation";
import { toSafeLeadership } from "@/models/Leadership";

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

section("Fixed role values");
check("exactly the two fixed positions exist", LEADERSHIP_ROLES.length === 2);
check("positions are unique", new Set(LEADERSHIP_ROLES).size === LEADERSHIP_ROLES.length);
check("chancellor is accepted", isLeadershipRole("chancellor"));
check("vice-chancellor is accepted", isLeadershipRole("vice-chancellor"));
check("an arbitrary role is rejected", !isLeadershipRole("king"));
check("an arbitrary role is rejected (2)", !isLeadershipRole("dean"));
check("a non-string is rejected", !isLeadershipRole(42));
check("empty is rejected", !isLeadershipRole(""));

section("Every fixed position has a label");
for (const role of LEADERSHIP_ROLES) {
  check(`${role}: label`, typeof LEADERSHIP_ROLE_LABELS[role] === "string");
}

section("Every fixed position has complete default information");
for (const role of LEADERSHIP_ROLES) {
  const def = LEADERSHIP_DEFAULTS[role];
  check(`${role}: default exists`, !!def);
  check(`${role}: name`, typeof def.name === "string" && def.name.trim().length > 0);
  check(
    `${role}: designation`,
    typeof def.designation === "string" && def.designation.trim().length > 0
  );
  check(`${role}: alt text`, typeof def.altText === "string" && def.altText.trim().length > 0);
  check(
    `${role}: description`,
    typeof def.description === "string" && def.description.trim().length > 0
  );
  check(
    `${role}: non-negative display order`,
    Number.isInteger(def.displayOrder) && def.displayOrder >= 0
  );
}
check(
  "the Chancellor sorts before the Vice Chancellor",
  LEADERSHIP_DEFAULTS.chancellor.displayOrder <
    LEADERSHIP_DEFAULTS["vice-chancellor"].displayOrder
);
check(
  "the two defaults are distinct people",
  LEADERSHIP_DEFAULTS.chancellor.name !== LEADERSHIP_DEFAULTS["vice-chancellor"].name
);

section("Default photographs are present and valid images");
for (const role of LEADERSHIP_ROLES) {
  const def = LEADERSHIP_DEFAULTS[role];
  const abs = path.resolve(process.cwd(), "public", "leadership-defaults", def.imageFile);
  check(`${role}: default image file exists`, fs.existsSync(abs));

  const image = readLeadershipDefaultImage(role);
  check(`${role}: image readable`, image !== null);
  check(
    `${role}: image signature is a supported type`,
    !!image && sniffImageType(image.data) === image.contentType
  );
}

section("Admin serializer exposes only the intended fields (no profile URL)");
const doc = {
  _id: { toString: () => "document-id" },
  role: "chancellor",
  name: "Smt. Anandiben Patel",
  designation: "Hon'ble Chancellor",
  description: "A biography.",
  // A legacy document may still carry this field; it must never be returned.
  profileUrl: "/administration/chancellor",
  imageId: "64b7f0c2a1b2c3d4e5f60718",
  imageName: "chancellor.png",
  altText: "Portrait of Smt. Anandiben Patel",
  displayOrder: 10,
  isActive: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as Parameters<typeof toSafeLeadership>[0];

const out = toSafeLeadership(doc);

check(
  "exactly the expected keys are present",
  JSON.stringify(Object.keys(out).sort()) ===
    JSON.stringify(
      [
        "altText",
        "createdAt",
        "description",
        "designation",
        "displayOrder",
        "id",
        "imageId",
        "imageName",
        "isActive",
        "name",
        "role",
        "updatedAt",
      ].sort()
    )
);
check("profileUrl is NOT exposed", !("profileUrl" in out));
check("role is preserved", out.role === "chancellor");
check("id is stringified", out.id === "document-id");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
