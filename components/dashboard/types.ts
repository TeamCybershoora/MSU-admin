/**
 * Dashboard view-model types.
 *
 * These describe what the UI renders — deliberately independent of the API
 * shape, so the backend response can evolve without touching any component.
 *
 * The single mapping points are:
 *   buildOverviewViewModel()   → ./dashboard-data.ts   (Screen A)
 *   buildGeographyViewModel()  → ./geography-data.ts   (Screen B)
 */

/** One day of a real server-side activity series. */
export interface DailyCount {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  count: number;
}

export interface NamedCount {
  label: string;
  value: number;
}

export interface DistrictCount {
  /** College district, or "" when the record has no district assigned. */
  district: string;
  value: number;
}

export type RecentActivityKind = "student" | "enquiry" | "enrolment";

export interface RecentActivity {
  id: string;
  kind: RecentActivityKind;
  /** ISO timestamp. */
  at: string;
  /** Non-personal context only (enrolment action, enquiry type). */
  detail?: string;
}

/**
 * Real aggregates returned by `GET /api/admin/dashboard?analytics=1`.
 * Mirrors `DashboardAnalytics` in @/lib/dashboard-analytics (server).
 */
export interface DashboardAnalytics {
  series: {
    registrations: DailyCount[];
    enquiries: DailyCount[];
    enrolments: DailyCount[];
  };
  topColleges: NamedCount[];
  topProgrammes: NamedCount[];
  applicationStatus: Record<string, number>;
  enquiryStatus: Record<string, number>;
  enquiriesByType: NamedCount[];
  studentsByDistrict: DistrictCount[];
  collegesByDistrict: DistrictCount[];
  recentActivity: RecentActivity[];
  generatedAt: string;
}

/**
 * Shape of `GET /api/admin/dashboard`'s `data` payload (kept in sync with
 * app/api/admin/dashboard/route.ts).
 */
export interface DashboardApiStats {
  totalStudents: number;
  totalResults: number;
  totalSyllabus: number;
  totalStructuredSyllabus?: number;
  totalProgrammeSyllabus?: number;
  totalColleges?: number;
  totalFaculty?: number | null;
  pendingApplications?: number | null;
  upcomingExams?: number | null;
  enquiriesByStatus?: {
    new: number;
    in_review: number;
    responded: number;
    closed: number;
  };
  /** Present only when the request asked for `?analytics=1`. */
  analytics?: DashboardAnalytics;
}

export type RangeKey = "30d" | "90d" | "6m" | "12m";

/** The time-range segmented control's options, in display order. */
export const RANGE_OPTIONS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: "30d", label: "30 Days" },
  { key: "90d", label: "90 Days" },
  { key: "6m", label: "6 Months" },
  { key: "12m", label: "12 Months" },
];

/** Logical icon names, mapped to lucide components inside the UI layer. */
export type MetricIcon =
  | "students"
  | "colleges"
  | "results"
  | "syllabus"
  | "enquiries"
  | "verification"
  | "enrolment"
  | "response"
  | "district";

export interface MetricItem {
  id: string;
  label: string;
  /** `null` renders the "not available yet" treatment instead of a number. */
  value: number | null;
  icon: MetricIcon;
  /** Small unit word shown after the number, e.g. "records". */
  unit?: string;
  /**
   * Only ever a REAL, measured change. `null` when no historical source exists
   * — the UI must never invent a trend, so `null` renders no badge.
   */
  trendPct?: number | null;
  hint?: string;
  accent?: "primary" | "secondary" | "highlight";
}

export interface SeriesPoint {
  /** Axis / tooltip label (e.g. "12 Mar" or "Mar 26"). */
  label: string;
  value: number;
}

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
}

export interface RankedRow {
  id: string;
  label: string;
  value: number;
  /** Optional secondary text (e.g. a district). */
  meta?: string;
}

export interface ActivityItem {
  id: string;
  title: string;
  detail?: string;
  /** Pre-formatted relative/absolute time string. */
  at?: string;
}

/** Everything the Overview screen (Screen A) needs, resolved for one range. */
export interface OverviewViewModel {
  hero: MetricItem;
  metrics: MetricItem[];

  series: SeriesPoint[];
  seriesTitle: string;
  seriesSubtitle: string;
  seriesValueLabel: string;
  /** True when the backend returned no registration history at all. */
  seriesEmpty: boolean;

  distribution: DonutSlice[];
  distributionTitle: string;
  distributionSubtitle: string;
  distributionCenterLabel: string;

  ranked: RankedRow[];
  rankedTitle: string;
  rankedSubtitle: string;
  rankedUnit: string;

  activity: ActivityItem[];
}

/**
 * Everything the Geography / Shares screen (Screen B) needs.
 *
 * Reuses the SAME building blocks as Overview so both screens render through
 * one component system. All values are computed from real records; where the
 * backend has no data the collection is empty and the section shows its own
 * empty state rather than inventing a placeholder.
 */
export interface GeographyViewModel {
  /** Row 1 — geography, ranked by the measure with real data. */
  regions: RankedRow[];
  regionsUnit: string;
  regionsTitle: string;
  regionsSubtitle: string;
  /**
   * What `regions` measures. MSU resolves a student's district through their
   * college name; when no student maps cleanly, the ranking falls back to the
   * affiliated colleges per district rather than showing an empty card.
   */
  regionsMeasure: "students" | "colleges";
  /** Shown when student-level district mapping is unavailable. */
  regionsNotice?: string;
  /** Students whose college has no resolvable district. */
  regionsUnassigned: number;
  /** Affiliated colleges per district (secondary measure). */
  collegesByRegion: RankedRow[];
  collegesUnit: string;
  /** Geographic visual — whichever measure has data. */
  districtSlices: DonutSlice[];
  districtCenterLabel: string;

  /** Row 2 — real distribution shares. */
  shares: MetricItem[];
  sharesTitle: string;
  sharesSubtitle: string;

  series: SeriesPoint[];
  seriesTitle: string;
  seriesSubtitle: string;
  seriesValueLabel: string;
  seriesEmpty: boolean;

  activity: ActivityItem[];
}
