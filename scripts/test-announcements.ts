/**
 * Offline verification of Announcement Bar Management rules.
 *
 * Runs entirely in memory: it never connects to MongoDB, never reads an
 * environment value and never writes anything. The validation + timezone logic
 * lives in lib/announcement-validation.ts as pure functions, so it can be
 * exercised without a database or an HTTP request.
 *
 * Coverage:
 *   1. IST <-> UTC round-trips (fixed +05:30, no DST)
 *   2. rejection of malformed IST values (no silent date roll-over)
 *   3. optional-date parsing ("" → null, ISO instant, bare local → IST)
 *   4. destination-link validation (internal path / https ok; unsafe rejected)
 *   5. schedule-window rule (end must be after start)
 *   6. admin serializer field shape + ISO formatting
 *
 * Usage: npx tsx scripts/test-announcements.ts
 */
import {
  formatIstDateTime,
  istInputToUtc,
  parseDisplayOrder,
  parseOptionalDate,
  toIstInputValue,
  validateHref,
  validateScheduleWindow,
} from "@/lib/announcement-validation";
import { toSafeAnnouncement } from "@/models/Announcement";

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

section("IST wall clock converts to the correct UTC instant");
{
  const date = istInputToUtc("2026-08-01T10:00");
  check("10:00 IST → 04:30 UTC", date?.toISOString() === "2026-08-01T04:30:00.000Z");
}

section("Round-trip never shifts the scheduled time");
{
  const cases = ["2026-01-01T00:00", "2026-08-01T10:00", "2026-12-31T23:59"];
  for (const value of cases) {
    const utc = istInputToUtc(value);
    check(`${value} IST round-trips`, utc !== null && toIstInputValue(utc) === value);
  }
}

section("Malformed IST values are rejected (no roll-over)");
check("month 13 rejected", istInputToUtc("2026-13-01T10:00") === null);
check("day 32 rejected", istInputToUtc("2026-01-32T10:00") === null);
check("Feb 30 rejected", istInputToUtc("2026-02-30T10:00") === null);
check("bare date rejected", istInputToUtc("2026-08-01") === null);
check("empty rejected", istInputToUtc("") === null);

function optionalDateIso(value: unknown): string | null {
  const result = parseOptionalDate(value);
  return result.ok && result.data ? result.data.toISOString() : null;
}

function optionalDateIsEmpty(value: unknown): boolean {
  const result = parseOptionalDate(value);
  return result.ok && result.data === null;
}

section("Optional dates: blank means 'no bound', not an epoch date");
check('"" → null', optionalDateIsEmpty(""));
check("null → null", optionalDateIsEmpty(null));
check("undefined → null", optionalDateIsEmpty(undefined));
check(
  "ISO instant parsed",
  optionalDateIso("2026-07-15T00:00:00.000Z") === "2026-07-15T00:00:00.000Z"
);
check(
  "bare local string read as IST",
  optionalDateIso("2026-08-01T10:00") === "2026-08-01T04:30:00.000Z"
);
check("garbage rejected", !parseOptionalDate("not-a-date").ok);

section("Destination links: internal path or https only");
check("internal path accepted", validateHref("/admissions").ok);
check("https URL accepted", validateHref("https://example.edu/page").ok);
check("javascript: rejected", !validateHref("javascript:alert(1)").ok);
check("data: rejected", !validateHref("data:text/html,x").ok);
check("protocol-relative //host rejected", !validateHref("//evil.example").ok);
check("plain http rejected", !validateHref("http://example.edu").ok);
check("empty rejected", !validateHref("").ok);
check("whitespace in path rejected", !validateHref("/ad missions").ok);

section("Schedule window: end must be strictly after start");
{
  const start = new Date("2026-08-01T00:00:00.000Z");
  const later = new Date("2026-08-02T00:00:00.000Z");
  const earlier = new Date("2026-07-31T00:00:00.000Z");
  check("end after start accepted", validateScheduleWindow(start, later).ok);
  check("end before start rejected", !validateScheduleWindow(start, earlier).ok);
  check("equal bounds rejected", !validateScheduleWindow(start, start).ok);
  check("open-ended accepted", validateScheduleWindow(start, null).ok);
  check("fully open accepted", validateScheduleWindow(null, null).ok);
}

section("Display order parses as a non-negative integer");
check('"" → 0', parseDisplayOrder("") === 0);
check('"30" → 30', parseDisplayOrder("30") === 30);
check("negative rejected", parseDisplayOrder("-1") === null);
check("non-numeric rejected", parseDisplayOrder("abc") === null);

section("Admin serializer exposes the managed fields and ISO instants");
{
  const doc = {
    _id: { toString: () => "announcement-id" },
    eyebrow: "MSU · 2026–27 SESSION",
    headline: "ADMISSIONS OPEN",
    sub: "Applications are now open",
    href: "/admissions",
    isEnabled: true,
    startAt: new Date("2026-08-01T04:30:00.000Z"),
    endAt: null,
    displayOrder: 10,
    createdBy: "admin-1",
    updatedBy: "admin-2",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  } as unknown as Parameters<typeof toSafeAnnouncement>[0];

  const out = toSafeAnnouncement(doc);
  check("id stringified", out.id === "announcement-id");
  check("headline preserved", out.headline === "ADMISSIONS OPEN");
  check("href preserved", out.href === "/admissions");
  check("startAt serialised as ISO", out.startAt === "2026-08-01T04:30:00.000Z");
  check("missing endAt is null", out.endAt === null);
  check("audit fields exposed", out.createdBy === "admin-1" && out.updatedBy === "admin-2");
  check(
    "exactly the expected keys are present",
    JSON.stringify(Object.keys(out).sort()) ===
      JSON.stringify(
        [
          "createdAt",
          "createdBy",
          "displayOrder",
          "endAt",
          "eyebrow",
          "headline",
          "href",
          "id",
          "isEnabled",
          "startAt",
          "sub",
          "updatedAt",
          "updatedBy",
        ].sort()
      )
  );
}

section("IST display helper renders a labelled instant");
{
  const formatted = formatIstDateTime("2026-08-01T04:30:00.000Z");
  check("contains IST label", formatted.endsWith("IST"));
  check("missing value renders a dash", formatIstDateTime(null) === "—");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
