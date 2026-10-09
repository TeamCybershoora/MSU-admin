/** Barrel export for the dashboard component layer. */

export { default as MetricCard } from "./metric-card";
export { default as ChartCard } from "./chart-card";
export { default as TimeRangeSelector } from "./time-range-selector";
export { default as LineChart } from "./line-chart";
export { default as DonutChart } from "./donut-chart";
export { default as RankedTable } from "./ranked-table";
export { default as ActivityFeed } from "./activity-feed";
export { default as Reveal } from "./reveal";
export { SkeletonBlock, SkeletonMetricGrid, SkeletonChart, SkeletonRows } from "./skeleton";

export { buildOverviewViewModel } from "./dashboard-data";
export { buildGeographyViewModel } from "./geography-data";

export type { DashboardApiStats } from "./types";
export type {
  ActivityItem,
  DailyCount,
  DashboardAnalytics,
  DistrictCount,
  DonutSlice,
  GeographyViewModel,
  MetricItem,
  NamedCount,
  OverviewViewModel,
  RangeKey,
  RankedRow,
  RecentActivity,
  SeriesPoint,
} from "./types";
export { RANGE_OPTIONS } from "./types";
