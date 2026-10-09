"use client";

/**
 * Screen B — Geography / Shares.
 *
 * The brief names this screen "GEOGRAPHY / SHARES" (not a generic "Insights"),
 * so the structure is:
 *   Row 1  Geography  — ranked region table + a visual geographic representation
 *   Row 2  Shares     — the real trend line + 2×2 distribution-share metrics
 *
 * HONEST DATA RULE (from the brief): geography is only shown when the backend
 * actually holds it. MSU records a district on every affiliated college, and a
 * student's district is resolved through their college, so the ranked regions
 * and the distribution ring are real. When no college has a district assigned,
 * the card shows a professional empty state instead of inventing regions.
 *
 * "Shares" is read as real distribution shares (enrolment completion,
 * verification, enquiry response, district coverage) rather than fabricated
 * social-sharing statistics, which this application does not collect.
 *
 * Data comes from GET /api/admin/dashboard?analytics=1 through
 * buildGeographyViewModel() — the same layered contract Screen A uses.
 * Security is unchanged: the stored JWT is sent as a Bearer token.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, MapPin, RefreshCw } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Button from "@/components/ui/button";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import {
  buildGeographyViewModel,
  ChartCard,
  DonutChart,
  LineChart,
  MetricCard,
  RankedTable,
  RANGE_OPTIONS,
  SkeletonChart,
  SkeletonMetricGrid,
  SkeletonRows,
  TimeRangeSelector,
} from "@/components/dashboard";
import type { DashboardApiStats, RangeKey } from "@/components/dashboard";
import styles from "./page.module.css";

export default function GeographySharesScreen() {
  const [stats, setStats] = useState<DashboardApiStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [range, setRange] = useState<RangeKey>("90d");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      const token = getStoredToken();
      if (!token) return;

      try {
        const res = await fetch("/api/admin/dashboard?analytics=1", {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          if (!cancelled) setError("Unable to load dashboard statistics.");
          return;
        }

        const data = await res.json();
        if (!cancelled && data.success) {
          setStats(data.data);
          setError("");
        }
      } catch {
        if (!cancelled) setError("Unable to connect to server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStats();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setError("");
    setLoading(true);
    setReloadKey((key) => key + 1);
  }, []);

  const vm = useMemo(() => buildGeographyViewModel(stats, range), [stats, range]);

  const sectionError = (
    <ErrorState
      title="Unable to load"
      description={error || "Something went wrong."}
      onRetry={reload}
    />
  );

  const noDistrictData = (
    <EmptyState
      icon={<MapPin />}
      title="No district data available"
      description="Affiliated colleges do not have a district recorded yet. Assign districts in College Management and the geographic breakdown appears here."
    />
  );

  return (
    <>
      <header className={styles.intro}>
        <div className={styles.introText}>
          <h2 className={styles.introTitle}>Geography &amp; Shares</h2>
          <p className={styles.introSubtitle}>
            Where MSU students and colleges are located, and how the current
            records are distributed.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className={styles.refreshIcon} aria-hidden="true" />
          Refresh
        </Button>
      </header>

      {/* ── Row 1 — geography ────────────────────────────────────── */}
      <div className={styles.row1}>
        <ChartCard
          className={styles.chartSlot}
          title={vm.regionsTitle}
          subtitle={vm.regionsSubtitle}
        >
          {loading ? (
            <SkeletonRows rows={5} />
          ) : error ? (
            sectionError
          ) : vm.regions.length === 0 && vm.collegesByRegion.length === 0 ? (
            noDistrictData
          ) : (
            <div className={styles.geographyBody}>
              <RankedTable
                rows={vm.regions}
                unit={vm.regionsUnit}
                emptyLabel="No district data available."
              />

              {vm.regionsNotice && <p className={styles.notice}>{vm.regionsNotice}</p>}

              {/*
                Student-level geography is the primary measure, so when it is
                available the college count per district is shown as a
                secondary measure below it. When student geography is
                unavailable the ranking above already shows colleges.
              */}
              {vm.regionsMeasure === "students" && vm.collegesByRegion.length > 0 && (
                <div className={styles.subSection}>
                  <h4 className={styles.subTitle}>Affiliated colleges by district</h4>
                  <RankedTable rows={vm.collegesByRegion} unit={vm.collegesUnit} />
                </div>
              )}
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Geographic distribution"
          subtitle={
            vm.regionsMeasure === "students"
              ? "Share of registered students by district"
              : "Affiliated colleges by district"
          }
        >
          {loading ? (
            <SkeletonChart height={220} />
          ) : error ? (
            sectionError
          ) : vm.districtSlices.length === 0 ? (
            noDistrictData
          ) : (
            <DonutChart
              slices={vm.districtSlices}
              centerLabel={vm.districtCenterLabel}
              height={220}
            />
          )}
        </ChartCard>
      </div>

      {/* ── Row 2 — shares ───────────────────────────────────────── */}
      <div className={styles.row1}>
        <ChartCard
          className={styles.chartSlot}
          title={vm.seriesTitle}
          subtitle={vm.seriesSubtitle}
          actions={
            <TimeRangeSelector value={range} onChange={setRange} options={RANGE_OPTIONS} />
          }
        >
          {loading ? (
            <SkeletonChart height={300} />
          ) : error ? (
            sectionError
          ) : vm.seriesEmpty ? (
            <EmptyState
              icon={<Activity />}
              title="No enquiries recorded"
              description="No website enquiries were received in this period."
            />
          ) : (
            <LineChart
              points={vm.series}
              valueLabel={vm.seriesValueLabel}
              height={300}
              replayKey={range}
            />
          )}
        </ChartCard>

        {loading ? (
          <SkeletonMetricGrid count={4} />
        ) : error ? (
          <ChartCard title={vm.sharesTitle}>{sectionError}</ChartCard>
        ) : (
          <div className={styles.metricGrid}>
            {vm.shares.map((metric, index) => (
              <MetricCard
                key={metric.id}
                item={metric}
                index={index}
                className={styles.metricSlot}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
