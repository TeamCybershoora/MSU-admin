"use client";

/**
 * Skeletons — shape-matched loading placeholders.
 *
 * Rules from the brief:
 *   - a data load never leaves a blank panel,
 *   - the shimmer is slow and subtle (~2.2 s, no flashing),
 *   - the skeleton only covers the section that is loading; when its data
 *     arrives it simply swaps for the real content (the surrounding dashboard
 *     entrance is NOT replayed).
 */

import type { CSSProperties } from "react";
import styles from "./skeleton.module.css";

interface BlockProps {
  className?: string;
  style?: CSSProperties;
}

export function SkeletonBlock({ className = "", style }: BlockProps) {
  return <span className={`${styles.block} ${className}`} style={style} aria-hidden="true" />;
}

/** 2×2 metric grid placeholder (matches MetricCard height). */
export function SkeletonMetricGrid({ count = 4 }: { count?: number }) {
  return (
    <div className={styles.metricGrid} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={styles.metricCard}>
          <div className={styles.metricHead}>
            <SkeletonBlock className={styles.chip} />
            <SkeletonBlock className={styles.lineShort} />
          </div>
          <SkeletonBlock className={styles.value} />
        </div>
      ))}
    </div>
  );
}

/** Chart-shaped placeholder (draws a fake baseline + bars). */
export function SkeletonChart({ height = 300 }: { height?: number }) {
  return (
    <div className={styles.chart} style={{ height }} aria-hidden="true">
      <div className={styles.chartBars}>
        {[46, 62, 38, 74, 56, 82, 48, 68, 90, 58, 76, 64].map((h, i) => (
          <SkeletonBlock key={i} style={{ height: `${h}%` }} className={styles.bar} />
        ))}
      </div>
    </div>
  );
}

/** Row list placeholder (matches table/feed rows). */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className={styles.rows} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.row}>
          <SkeletonBlock className={styles.lineWide} />
          <SkeletonBlock className={styles.lineNarrow} />
        </div>
      ))}
    </div>
  );
}
