"use client";

/**
 * MetricCard — one KPI tile (and the visually prominent HeroMetricCard).
 *
 * Motion contract:
 *   - entrance: opacity 0→1, scale 0.96→1, ~300 ms, staggered by `index`
 *     (the hero is simply given the last index so it enters last),
 *   - value counts up from 0 on mount,
 *   - on a later data refresh the number interpolates to the new value and the
 *     card does NOT re-animate (the entrance animation only runs on mount).
 */

import {
  BookOpen,
  Building2,
  FileText,
  GraduationCap,
  Inbox,
  MapPin,
  MessageSquare,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useCountUp } from "./hooks";
import { STAGGER_MS } from "./motion";
import type { MetricIcon, MetricItem } from "./types";
import styles from "./metric-card.module.css";

const ICONS: Record<MetricIcon, LucideIcon> = {
  students: Users,
  colleges: Building2,
  results: FileText,
  syllabus: BookOpen,
  enquiries: Inbox,
  verification: ShieldCheck,
  enrolment: GraduationCap,
  response: MessageSquare,
  district: MapPin,
};

const numberFormat = new Intl.NumberFormat("en-IN");

interface MetricCardProps {
  item: MetricItem;
  /** Position in the grid — drives the entrance stagger. */
  index?: number;
  /** Renders the larger, emphasised hero treatment. */
  hero?: boolean;
  /** Extra class from the parent (e.g. the mobile reflow ordering hook). */
  className?: string;
}

export default function MetricCard({
  item,
  index = 0,
  hero = false,
  className = "",
}: MetricCardProps) {
  const display = useCountUp(item.value, { startDelay: hero ? 120 : index * STAGGER_MS });
  const Icon = ICONS[item.icon];

  const hasTrend = typeof item.trendPct === "number" && item.trendPct !== 0;
  const trendUp = hasTrend && (item.trendPct as number) > 0;

  return (
    <article
      className={`${styles.card} ${hero ? styles.hero : ""} ${
        item.accent ? styles[item.accent] : ""
      } ${className}`}
      style={{ "--enter-index": index } as CSSProperties}
      aria-label={item.label}
      data-metric={item.id}
    >
      <header className={styles.head}>
        <span className={styles.iconChip} aria-hidden="true">
          <Icon />
        </span>
        <div className={styles.headText}>
          <p className={styles.label}>{item.label}</p>
          {item.hint && <p className={styles.hint}>{item.hint}</p>}
        </div>
        {hasTrend && (
          <span
            className={`${styles.trend} ${trendUp ? styles.trendUp : styles.trendDown}`}
          >
            {trendUp ? <TrendingUp /> : <TrendingDown />}
            {trendUp ? "+" : ""}
            {(item.trendPct as number).toFixed(1)}%
          </span>
        )}
      </header>

      <div className={styles.valueRow}>
        {display === null ? (
          <span className={styles.unavailable}>Not available yet</span>
        ) : (
          <>
            <span className={styles.value}>{numberFormat.format(Math.round(display))}</span>
            {item.unit && <span className={styles.unit}>{item.unit}</span>}
          </>
        )}
      </div>
    </article>
  );
}
