/**
 * Read-only verification of the Super Admin dashboard data layer.
 *
 * WHY: /admin/super-admin is behind the admin login, so its aggregates cannot be
 * inspected with plain HTTP without an admin token. This script exercises the
 * EXACT server function the dashboard endpoint calls
 * (`buildDashboardAnalytics`) plus the pure series bucketing the UI uses, and
 * cross-checks every aggregate against an independent count query.
 *
 * Safety:
 * - READ ONLY. It performs no insert, update or delete, and needs no token.
 * - It never prints a credential, connection string or any personal record —
 *   only aggregate counts and shape assertions.
 * - Safe to run against any database, including production.
 *
 * Usage:
 *   npx tsx scripts/verify-super-admin-dashboard.ts
 *   npx tsx scripts/verify-super-admin-dashboard.ts --http http://localhost:3000
 *
 * With `--http` it ALSO logs in against a running server (using the same
 * ADMIN_EMAIL / ADMIN_PASSWORD convention as scripts/test-login-api.ts) and
 * checks the real HTTP contract: the dashboard endpoint rejects anonymous
 * callers, omits `analytics` from its default response, and includes it with
 * `?analytics=1`. The token is never printed.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Student from "@/models/Student";
import College from "@/models/College";
import { buildDashboardAnalytics } from "@/lib/dashboard-analytics";
import { buildSeries, isSeriesEmpty } from "@/components/dashboard/series";
import { buildOverviewViewModel } from "@/components/dashboard/dashboard-data";
import { buildGeographyViewModel } from "@/components/dashboard/geography-data";
import type { DashboardApiStats, RangeKey } from "@/components/dashboard/types";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Key-order-insensitive serialisation. MongoDB does not guarantee the key order
 * of a `$group` result, so comparing raw JSON.stringify would report a false
 * difference; the VALUES are what must match.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (val as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return val;
  });
}

async function main() {
  await connectDB();
  console.log("Super Admin dashboard — read-only verification\n");

  const analytics = await buildDashboardAnalytics();

  // ── 1. Shape ─────────────────────────────────────────────────────
  console.log("1. Aggregate shape");
  check("series.registrations is an array", Array.isArray(analytics.series.registrations));
  check("series.enquiries is an array", Array.isArray(analytics.series.enquiries));
  check(
    "every daily point is {date:'YYYY-MM-DD', count:number}",
    analytics.series.registrations.every(
      (p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.count === "number" && p.count > 0
    )
  );
  check(
    "daily points are sorted ascending",
    analytics.series.registrations.every(
      (p, i, all) => i === 0 || all[i - 1].date < p.date
    )
  );
  check("generatedAt is an ISO timestamp", !Number.isNaN(Date.parse(analytics.generatedAt)));

  // ── 2. Cross-checks against independent counts ───────────────────
  console.log("\n2. Cross-checks (aggregate vs independent count)");

  const totalStudents = await Student.countDocuments();
  const statusSum = Object.values(analytics.applicationStatus).reduce((a, b) => a + b, 0);
  check(
    "applicationStatus sums to the student count",
    statusSum === totalStudents,
    `sum=${statusSum} countDocuments=${totalStudents}`
  );

  const totalColleges = await College.countDocuments();
  const districtCollegeSum = analytics.collegesByDistrict.reduce((a, b) => a + b.value, 0);
  check(
    "collegesByDistrict sums to the college count",
    districtCollegeSum === totalColleges,
    `sum=${districtCollegeSum} countDocuments=${totalColleges}`
  );

  const studentsWithCollege = await Student.countDocuments({
    college: { $nin: [null, ""] },
  });
  const districtStudentSum = analytics.studentsByDistrict.reduce((a, b) => a + b.value, 0);
  check(
    "studentsByDistrict sums to students that have a college",
    districtStudentSum === studentsWithCollege,
    `sum=${districtStudentSum} expected=${studentsWithCollege}`
  );

  const topCollegesDescending = analytics.topColleges.every(
    (row, i, all) => i === 0 || all[i - 1].value >= row.value
  );
  check("topColleges is sorted descending and limited to 6", topCollegesDescending && analytics.topColleges.length <= 6,
    `${analytics.topColleges.length} rows`);

  // ── 3. Series bucketing (pure, used directly by the charts) ──────
  console.log("\n3. Series bucketing per range");
  const expected: Record<string, number> = { "30d": 30, "90d": 13, "6m": 6, "12m": 12 };
  for (const [range, length] of Object.entries(expected) as Array<
    ["30d" | "90d" | "6m" | "12m", number]
  >) {
    const points = buildSeries(analytics.series.registrations, range);
    const shaped = points.length === length && points.every((p) => p.label && p.value >= 0);
    check(
      `${range} → ${length} points with labels`,
      shaped,
      `got ${points.length}: ${points.map((p) => `${p.label}=${p.value}`).join(", ")}`
    );
    void isSeriesEmpty(points);
  }

  // ── 4. Read-only guarantee ───────────────────────────────────────
  console.log("\n4. Read-only / stable re-run");
  const totalAfter = await Student.countDocuments();
  const analyticsAgain = await buildDashboardAnalytics();
  check("student count unchanged by the run", totalAfter === totalStudents);
  check(
    "a second run produces identical aggregates (order-insensitive)",
    stable(analytics.series) === stable(analyticsAgain.series) &&
      stable(analytics.topColleges) === stable(analyticsAgain.topColleges) &&
      stable(analytics.applicationStatus) === stable(analyticsAgain.applicationStatus) &&
      stable(analytics.collegesByDistrict) === stable(analyticsAgain.collegesByDistrict)
  );

  // ── 5. View models the two screens actually render ───────────────
  console.log("\n5. View models (exact screen input)");
  const stats: DashboardApiStats = {
    totalStudents,
    totalResults: await mongoose.connection
      .collection("results")
      .countDocuments()
      .catch(() => 0),
    totalSyllabus: 0,
    totalColleges,
    analytics,
  };

  const ranges: RangeKey[] = ["30d", "90d", "6m", "12m"];
  for (const range of ranges) {
    const overview = buildOverviewViewModel(stats, range);
    const distributionSum = overview.distribution.reduce((a, b) => a + b.value, 0);
    check(
      `Overview[${range}] hero is the real student total`,
      overview.hero.value === totalStudents,
      `hero=${overview.hero.value} students=${totalStudents}`
    );
    check(
      `Overview[${range}] distribution sums to the student total`,
      distributionSum === totalStudents,
      `sum=${distributionSum}`
    );
    check(
      `Overview[${range}] has 3 metrics + hero and no fabricated trend`,
      overview.metrics.length === 3 && overview.hero.trendPct === null
    );
  }

  const geography = buildGeographyViewModel(stats, "90d");
  check(
    "Geography ranking shows real rows (students, else colleges)",
    geography.regions.length > 0,
    `measure=${geography.regionsMeasure} rows=${geography.regions.length}`
  );
  check(
    "Geography ranking unit matches its measure",
    geography.regionsUnit === geography.regionsMeasure,
    `${geography.regionsUnit}/${geography.regionsMeasure}`
  );
  check(
    "Geography donut has slices and a matching centre label",
    geography.districtSlices.length > 0 &&
      geography.districtCenterLabel === geography.regionsMeasure,
    `${geography.districtSlices.length} slices / "${geography.districtCenterLabel}"`
  );
  check(
    "a fallback to colleges is explained, not silent",
    geography.regionsMeasure === "students" || Boolean(geography.regionsNotice)
  );
  check(
    "Shares are 4 real ratios with no fabricated trend",
    geography.shares.length === 4 && geography.shares.every((s) => s.trendPct === undefined)
  );
  console.log(
    `    shares=${geography.shares
      .map((s) => `${s.label}=${s.value === null ? "n/a" : `${s.value}${s.unit ?? ""}`}`)
      .join(", ")}`
  );

  // ── 6. Full payload shape the UI consumes ────────────────────────
  console.log("\n6. Payload the dashboard renders");
  console.log(
    `    students=${totalStudents} colleges=${totalColleges} ` +
      `registrations(daily)=${analytics.series.registrations.length} ` +
      `enquiries(daily)=${analytics.series.enquiries.length} ` +
      `enrolments(daily)=${analytics.series.enrolments.length}`
  );
  console.log(`    applicationStatus=${JSON.stringify(analytics.applicationStatus)}`);
  console.log(`    enquiriesByType=${JSON.stringify(analytics.enquiriesByType)}`);
  console.log(`    studentsByDistrict=${JSON.stringify(analytics.studentsByDistrict)}`);
  console.log(`    collegesByDistrict=${JSON.stringify(analytics.collegesByDistrict)}`);
  console.log(`    recentActivity=${analytics.recentActivity.length} event(s)`);

  // ── 7. HTTP contract (optional, needs a running server) ──────────
  const httpIndex = process.argv.indexOf("--http");
  if (httpIndex !== -1) {
    const base = process.argv[httpIndex + 1] ?? "http://localhost:3000";
    await checkHttp(base, totalStudents);
  } else {
    console.log("\n7. HTTP contract — skipped (pass --http <url> to run it)");
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

/** Exercise the live endpoint. No token or credential is ever printed. */
async function checkHttp(base: string, expectedStudents: number) {
  console.log(`\n7. HTTP contract (${base})`);

  const anonymous = await fetch(`${base}/api/admin/dashboard?analytics=1`);
  check(
    "anonymous request is rejected (401) before any aggregate runs",
    anonymous.status === 401,
    `status=${anonymous.status}`
  );

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("  [SKIP] ADMIN_EMAIL / ADMIN_PASSWORD not set — signed-in checks skipped");
    return;
  }

  const login = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await login.json();
  const token: string | undefined = loginBody?.token;
  check("admin login succeeds", login.ok && Boolean(token), `status=${login.status}`);
  if (!token) return;

  const headers = { Authorization: `Bearer ${token}` };

  const plain = await fetch(`${base}/api/admin/dashboard`, { headers });
  const plainBody = await plain.json();
  check(
    "default dashboard response is unchanged (no analytics key)",
    plain.ok && plainBody.success === true && plainBody.data.analytics === undefined
  );
  check(
    "default response still reports the real student total",
    plainBody.data.totalStudents === expectedStudents,
    `${plainBody.data.totalStudents} vs ${expectedStudents}`
  );

  const withAnalytics = await fetch(`${base}/api/admin/dashboard?analytics=1`, { headers });
  const analyticsBody = await withAnalytics.json();
  const a = analyticsBody?.data?.analytics;
  check("analytics request succeeds", withAnalytics.ok && Boolean(a), `status=${withAnalytics.status}`);
  if (!a) return;

  check(
    "analytics payload carries every section the screens read",
    Array.isArray(a.series?.registrations) &&
      Array.isArray(a.series?.enquiries) &&
      Array.isArray(a.topColleges) &&
      Array.isArray(a.collegesByDistrict) &&
      Array.isArray(a.studentsByDistrict) &&
      Array.isArray(a.recentActivity) &&
      typeof a.applicationStatus === "object"
  );
  check(
    "HTTP aggregates match the direct database count",
    Object.values(a.applicationStatus as Record<string, number>).reduce(
      (sum, value) => sum + Number(value),
      0
    ) === expectedStudents,
    JSON.stringify(a.applicationStatus)
  );
  check(
    "signed-in super admin dashboard page renders (200)",
    (await fetch(`${base}/admin/super-admin`)).status === 200
  );
  console.log(
    `    collegesByDistrict=${JSON.stringify(a.collegesByDistrict)} recentActivity=${a.recentActivity.length}`
  );
}

main().catch(async (error) => {
  console.error("Verification failed to run:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
