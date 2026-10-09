"use client";

/**
 * Screen A — Overview.
 *
 * Layout (per the brief):
 *   Row 1  ~60% primary line chart  |  ~40% 2×2 metric grid (hero enters last)
 *   Row 2  ranked table             |  donut / ring distribution
 *   Row 3  recent activity          |  quick actions
 *
 * Responsive (per the brief's mobile section):
 *   desktop  chart left, 2×2 metrics right
 *   tablet   chart on top, then the 2×2 metrics, then ranked, then distribution
 *   mobile   hero metric → chart → remaining metrics → ranked → distribution
 *   (the reflow is driven by CSS `order` + `display: contents`; see page.module.css)
 *
 * Data: totals come from GET /api/admin/dashboard; the series, ranking,
 * distribution and activity come from the SAME endpoint with `?analytics=1`
 * (real read-only aggregates — see @/lib/dashboard-analytics). Nothing here is
 * fabricated: a section with no backend data shows its own empty state.
 *
 * Security is unchanged: the stored JWT is sent as a Bearer token. No auth or
 * authorization logic lives in this file.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Building2,
  Camera,
  Crown,
  FileText,
  Inbox,
  Layers,
  Megaphone,
  Newspaper,
  RefreshCw,
  Users,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Button from "@/components/ui/button";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import {
  ActivityFeed,
  buildOverviewViewModel,
  ChartCard,
  DonutChart,
  LineChart,
  MetricCard,
  RankedTable,
  RANGE_OPTIONS,
  Reveal,
  SkeletonChart,
  SkeletonMetricGrid,
  SkeletonRows,
  TimeRangeSelector,
} from "@/components/dashboard";
import type { DashboardApiStats, RangeKey } from "@/components/dashboard";
import styles from "./page.module.css";

/**
 * Dashboard shortcuts to the major Admin management modules, in the same order
 * as the sidebar. Admin Management is Super-Admin-only and lives in the sidebar;
 * Change Password / Logout are account utilities, not management modules.
 */
const QUICK_ACTIONS = [
  { href: "/admin/students", label: "Manage Students", icon: Users },
  { href: "/admin/academic-structure", label: "Academic Structure", icon: Layers },
  { href: "/admin/results", label: "Manage Results", icon: FileText },
  { href: "/admin/notices", label: "Notices", icon: Megaphone },
  { href: "/admin/news", label: "News", icon: Newspaper },
  { href: "/admin/spotlight", label: "Spotlight", icon: Camera },
  { href: "/admin/leadership", label: "Leadership", icon: Crown },
  { href: "/admin/syllabus", label: "Syllabus", icon: BookOpen },
  { href: "/admin/colleges", label: "Colleges", icon: Building2 },
  { href: "/admin/enquiries/admission", label: "Enquiries", icon: Inbox },
];

export default function OverviewScreen() {
  const [stats, setStats] = useState<DashboardApiStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [range, setRange] = useState<RangeKey>("30d");
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

  const vm = useMemo(() => buildOverviewViewModel(stats, range), [stats, range]);

  // Hero card is placed last so it enters last within the metric group.
  const metricTiles = useMemo(() => [...vm.metrics, vm.hero], [vm]);

  const sectionError = (
    <ErrorState
      title="Unable to load"
      description={error || "Something went wrong."}
      onRetry={reload}
    />
  );

  return (
    <>
      <header className={styles.intro}>
        <div className={styles.introText}>
          <h2 className={styles.introTitle}>Overview</h2>
          <p className={styles.introSubtitle}>
            Key university metrics, analytics and recent activity.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className={styles.refreshIcon} aria-hidden="true" />
          Refresh
        </Button>
      </header>

      {/* ── Row 1 — primary chart | 2×2 metrics ──────────────────── */}
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
              title="No registrations recorded"
              description="No new student accounts were created in this period. Once registrations come in, the trend appears here."
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
          <ChartCard title="Key metrics">{sectionError}</ChartCard>
        ) : (
          <div className={styles.metricGrid}>
            {metricTiles.map((metric, index) => {
              const isHero = metric.id === vm.hero.id;
              return (
                <MetricCard
                  key={metric.id}
                  item={metric}
                  index={index}
                  hero={isHero}
                  className={isHero ? styles.heroSlot : styles.metricSlot}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Row 2 — ranked data | distribution ───────────────────── */}
      <div className={styles.row2}>
        <ChartCard title={vm.rankedTitle} subtitle={vm.rankedSubtitle}>
          {loading ? (
            <SkeletonRows rows={5} />
          ) : error ? (
            sectionError
          ) : (
            <RankedTable
              rows={vm.ranked}
              unit={vm.rankedUnit}
              emptyLabel="No college enrolment recorded yet."
            />
          )}
        </ChartCard>

        <ChartCard title={vm.distributionTitle} subtitle={vm.distributionSubtitle}>
          {loading ? (
            <SkeletonChart height={220} />
          ) : error ? (
            sectionError
          ) : (
            <DonutChart
              slices={vm.distribution}
              centerLabel={vm.distributionCenterLabel}
              height={220}
            />
          )}
        </ChartCard>
      </div>

      {/* ── Row 3 — activity | quick actions ─────────────────────── */}
      <Reveal>
        <div className={styles.row2}>
          <ChartCard title="Recent activity" subtitle="Latest administration events">
            {loading ? (
              <SkeletonRows rows={4} />
            ) : error ? (
              sectionError
            ) : (
              <ActivityFeed
                items={vm.activity}
                emptyLabel="No administrative activity recorded yet."
              />
            )}
          </ChartCard>

          <ChartCard title="Quick actions" subtitle="Common administrative tasks">
            <div className={styles.actionsGrid}>
              {QUICK_ACTIONS.map((action) => (
                <Link key={action.href} href={action.href} className={styles.actionCard}>
                  <span className={styles.actionIcon}>
                    <action.icon />
                  </span>
                  <span className={styles.actionLabel}>{action.label}</span>
                  <ArrowRight size={15} className={styles.actionArrow} aria-hidden="true" />
                </Link>
              ))}
            </div>
          </ChartCard>
        </div>
      </Reveal>
    </>
  );
}
