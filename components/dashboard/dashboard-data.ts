/**
 * Dashboard data adapter (Screen A — Overview).
 *
 * Data flow (kept strictly layered, per the brief):
 *   API / data source  →  this adapter  →  components  →  visualisation
 *
 * EVERY value here comes from a real response:
 *   totals                GET /api/admin/dashboard
 *   series, rankings,
 *   distribution, activity GET /api/admin/dashboard?analytics=1
 *
 * There is no placeholder layer any more — if the backend has no data for a
 * section, the adapter returns an EMPTY collection and the section renders its
 * own empty state. Nothing on this screen is invented.
 *
 * `stats` may be null while loading / after an error, in which case every field
 * degrades to `null` or an empty collection rather than throwing, so each
 * section can show its own loading / error / empty state independently.
 */

import { toActivityItems } from "./activity";
import { buildSeries, isSeriesEmpty } from "./series";
import type { DashboardApiStats, OverviewViewModel, RangeKey } from "./types";

export type { DashboardApiStats } from "./types";

const SERIES_META: Record<RangeKey, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "6m": "Last 6 months",
  "12m": "Last 12 months",
};

/**
 * Application-review statuses, in the order the donut should read.
 * Keys are the stored `applicationStatus` values (legacy documents are counted
 * as `verified`, matching the review screens).
 */
const APPLICATION_SLICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "enrolled", label: "Enrolled" },
  { id: "verified", label: "Verified" },
  { id: "pending", label: "Pending review" },
  { id: "needs_correction", label: "Needs correction" },
  { id: "rejected", label: "Rejected" },
];

export function buildOverviewViewModel(
  stats: DashboardApiStats | null,
  range: RangeKey
): OverviewViewModel {
  const analytics = stats?.analytics;

  // ── Metrics (real totals) ────────────────────────────────────────
  const hero = {
    id: "students",
    label: "Total Students",
    value: stats?.totalStudents ?? null,
    icon: "students" as const,
    unit: "registered",
    // No historical source for a like-for-like change → no trend is claimed.
    trendPct: null,
    accent: "primary" as const,
    hint: "Across every affiliated college",
  };

  const metrics = [
    {
      id: "colleges",
      label: "Affiliated Colleges",
      value: stats?.totalColleges ?? null,
      icon: "colleges" as const,
      unit: "institutions",
      trendPct: null,
      accent: "secondary" as const,
    },
    {
      id: "results",
      label: "Result Records",
      value: stats?.totalResults ?? null,
      icon: "results" as const,
      unit: "published",
      trendPct: null,
    },
    {
      id: "syllabus",
      label: "Syllabus Documents",
      value: stats?.totalSyllabus ?? null,
      icon: "syllabus" as const,
      unit: "files",
      trendPct: null,
    },
  ];

  // ── Series (real daily registrations, bucketed for the range) ────
  const series = buildSeries(analytics?.series.registrations ?? [], range);

  // ── Distribution (real application-status counts) ────────────────
  const statusCounts = analytics?.applicationStatus;
  const distribution = APPLICATION_SLICES.map((slice) => ({
    id: slice.id,
    label: slice.label,
    value: statusCounts?.[slice.id] ?? 0,
  }));

  // ── Ranking (real college totals) ────────────────────────────────
  const ranked = (analytics?.topColleges ?? []).map((row, index) => ({
    id: `college-${index}`,
    label: row.label,
    value: row.value,
  }));

  return {
    hero,
    metrics,

    series,
    seriesTitle: "Student registrations",
    seriesSubtitle: `New student accounts · ${SERIES_META[range]}`,
    seriesValueLabel: "registrations",
    seriesEmpty: isSeriesEmpty(series),

    distribution,
    distributionTitle: "Applications by status",
    distributionSubtitle: "Every student account by review state",
    distributionCenterLabel: "students",

    ranked,
    rankedTitle: "Colleges by students",
    rankedSubtitle: "Registered students per affiliated college",
    rankedUnit: "students",

    activity: toActivityItems(analytics?.recentActivity ?? []),
  };
}
