/**
 * Geography data adapter (Screen B — Geography / Shares).
 *
 * Same layered contract as ./dashboard-data.ts:
 *   API / data source  →  this adapter  →  components  →  visualisation
 *
 * The brief is explicit that geography must only be shown when the backend
 * actually holds geographic data — never fabricated countries or regions. MSU
 * does hold real geography: every affiliated college records a `district`
 * (Saharanpur, Shamli, Muzaffarnagar) and a student's district is resolved
 * through their college. Every value below is derived from those real records:
 *
 *   regions              students per district
 *   districtSlices       students per district (the geographic visual)
 *   collegesByRegion     affiliated colleges per district
 *   shares               real ratios computed from real counts
 *   series               enquiries received over time
 *
 * Where the backend holds no geography (no district assigned to any college)
 * the collections are empty and the card shows a professional empty state
 * explaining that district data is not available — it does NOT invent regions.
 */

import { toActivityItems } from "./activity";
import { districtLabel, percentageOf } from "./format";
import { buildSeries, isSeriesEmpty } from "./series";
import type {
  DashboardApiStats,
  DistrictCount,
  GeographyViewModel,
  RangeKey,
} from "./types";

export type { DashboardApiStats } from "./types";

const SERIES_META: Record<RangeKey, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "6m": "Last 6 months",
  "12m": "Last 12 months",
};

function hasDistrict(row: DistrictCount): boolean {
  return Boolean(row.district && row.district.trim());
}

export function buildGeographyViewModel(
  stats: DashboardApiStats | null,
  range: RangeKey
): GeographyViewModel {
  const analytics = stats?.analytics;
  const totalStudents = stats?.totalStudents ?? 0;
  const totalColleges = stats?.totalColleges ?? 0;

  // ── Row 1 — geography ────────────────────────────────────────────
  const districtRows = analytics?.studentsByDistrict ?? [];

  const regions = districtRows
    .filter(hasDistrict)
    .map((row, index) => ({
      id: `district-${index}`,
      label: districtLabel(row.district),
      value: row.value,
    }));

  const regionsUnassigned = districtRows
    .filter((row) => !hasDistrict(row))
    .reduce((sum, row) => sum + row.value, 0);

  const collegesByRegion = (analytics?.collegesByDistrict ?? [])
    .filter(hasDistrict)
    .map((row, index) => ({
      id: `college-district-${index}`,
      label: districtLabel(row.district),
      value: row.value,
    }));

  const collegesWithDistrict = collegesByRegion.reduce((sum, row) => sum + row.value, 0);

  //
  // Student-level geography requires a student's college name to match a
  // College document. Where nothing matches (a real possibility while college
  // names are still being aligned) the RANKING falls back to the college count
  // per district — which is always real — instead of presenting an empty card.
  //
  const hasStudentGeography = regions.length > 0;
  const primaryRegions = hasStudentGeography ? regions : collegesByRegion;

  const districtSlices = hasStudentGeography
    ? regions.map((region) => ({
        id: region.id,
        label: region.label,
        value: region.value,
      }))
    : collegesByRegion.map((region) => ({
        id: region.id,
        label: region.label,
        value: region.value,
      }));

  // ── Row 2 — real distribution shares ─────────────────────────────
  const applicationStatus = analytics?.applicationStatus ?? {};
  const enrolled = applicationStatus.enrolled ?? 0;
  const verified = applicationStatus.verified ?? 0;

  const enquiryStatus = analytics?.enquiryStatus ?? {};
  const enquiryTotal = Object.values(enquiryStatus).reduce((sum, value) => sum + value, 0);
  const enquiryHandled = (enquiryStatus.responded ?? 0) + (enquiryStatus.closed ?? 0);

  const shares = [
    {
      id: "enrolment",
      label: "Enrolment Completion",
      value: percentageOf(enrolled, totalStudents),
      icon: "enrolment" as const,
      unit: "%",
      hint: "Students enrolled out of all registered",
      accent: "primary" as const,
    },
    {
      id: "verification",
      label: "Verified Applications",
      value: percentageOf(verified + enrolled, totalStudents),
      icon: "verification" as const,
      unit: "%",
      hint: "Verified or enrolled out of all registered",
      accent: "secondary" as const,
    },
    {
      id: "response",
      label: "Enquiry Response Rate",
      value: percentageOf(enquiryHandled, enquiryTotal),
      icon: "response" as const,
      unit: "%",
      hint: "Enquiries responded to or closed",
    },
    {
      id: "district-coverage",
      label: "Colleges with District",
      value: percentageOf(collegesWithDistrict, totalColleges),
      icon: "district" as const,
      unit: "%",
      hint: "Affiliated colleges mapped to a district",
    },
  ];

  // ── Real enquiry trend ───────────────────────────────────────────
  const series = buildSeries(analytics?.series.enquiries ?? [], range);

  return {
    regions: primaryRegions,
    regionsUnit: hasStudentGeography ? "students" : "colleges",
    regionsTitle: hasStudentGeography
      ? "Students by district"
      : "Colleges by district",
    regionsSubtitle: hasStudentGeography
      ? "Resolved through each student's college"
      : "Affiliated colleges in each district",
    regionsMeasure: hasStudentGeography ? "students" : "colleges",
    regionsNotice: hasStudentGeography
      ? undefined
      : regionsUnassigned > 0
        ? `${regionsUnassigned} student${
            regionsUnassigned === 1 ? "'s" : "s'"
          } college has no matching college record yet, so students could not be mapped to a district. Showing affiliated colleges per district instead.`
        : undefined,
    regionsUnassigned,

    collegesByRegion,
    collegesUnit: "colleges",

    districtSlices,
    districtCenterLabel: hasStudentGeography ? "students" : "colleges",

    shares,
    sharesTitle: "Distribution shares",
    sharesSubtitle: "Real ratios across the current records",

    series,
    seriesTitle: "Enquiries received",
    seriesSubtitle: `Website enquiries · ${SERIES_META[range]}`,
    seriesValueLabel: "enquiries",
    seriesEmpty: isSeriesEmpty(series),

    activity: toActivityItems(analytics?.recentActivity ?? []),
  };
}
