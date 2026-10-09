"use client";

/**
 * DonutChart — distribution ring with a clockwise sweep.
 *
 * Load animation: every segment grows together from 0 to its share (one shared
 * 820 ms ease-out sweep) while the centre value counts up over the SAME
 * duration, so ring and number start and end together.
 *
 * Hover: the hovered segment is nudged outward 2–4 px and thickened slightly;
 * the other segments stay visible (nothing is hidden), and the centre switches
 * to that slice's value.
 *
 * Reduced motion: the ring renders at its final sweep and the number snaps.
 */

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useCountUp } from "./hooks";
import { DONUT_SWEEP_MS } from "./motion";
import type { DonutSlice } from "./types";
import styles from "./donut-chart.module.css";

const SIZE = 140;
const CENTER = SIZE / 2;
const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const COLORS = ["var(--primary)", "var(--secondary)", "var(--highlight)", "#3f7d8c"];

const numberFormat = new Intl.NumberFormat("en-IN");

interface DonutChartProps {
  slices: DonutSlice[];
  /** Word shown under the centre value, e.g. "enquiries". */
  centerLabel: string;
  height?: number;
}

export default function DonutChart({ slices, centerLabel, height = 220 }: DonutChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const total = useMemo(() => slices.reduce((sum, s) => sum + s.value, 0), [slices]);

  // No mutation during render: each segment's start is derived from the slices
  // before it (n is tiny, so this is trivially cheap and stays pure).
  const segments = useMemo(() => {
    return slices.map((slice, index) => {
      const before = slices
        .slice(0, index)
        .reduce((sum, previous) => sum + previous.value, 0);
      const fraction = total > 0 ? slice.value / total : 0;
      const startFraction = total > 0 ? before / total : 0;
      const midFraction = startFraction + fraction / 2;
      const angle = (midFraction * 360 - 90) * (Math.PI / 180);
      return {
        ...slice,
        length: fraction * CIRCUMFERENCE,
        start: startFraction * CIRCUMFERENCE,
        dx: Math.cos(angle) * 4,
        dy: Math.sin(angle) * 4,
      };
    });
  }, [slices, total]);

  const hoveredSlice = segments.find((s) => s.id === hovered) ?? null;
  const centerValue = useCountUp(hoveredSlice ? hoveredSlice.value : total, {
    duration: DONUT_SWEEP_MS,
  });

  if (total === 0) {
    return (
      <div className={styles.empty} style={{ minHeight: height }}>
        <p>No data available for this period.</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={styles.svg}
        style={{ maxHeight: height }}
        role="img"
        aria-label={`${centerLabel} distribution`}
      >
        <circle
          className={styles.track}
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
        />
        {/* rotate so the sweep starts at 12 o'clock */}
        <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
          {segments.map((segment, index) => (
            <circle
              key={segment.id}
              className={`${styles.segment} ${hovered === segment.id ? styles.segmentActive : ""}`}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={COLORS[index % COLORS.length]}
              strokeWidth={hovered === segment.id ? 22 : 18}
              strokeDasharray={`${segment.length} ${CIRCUMFERENCE - segment.length}`}
              strokeDashoffset={-segment.start}
              style={
                {
                  "--c": CIRCUMFERENCE,
                  "--len": segment.length,
                  "--donut-dur": `${DONUT_SWEEP_MS}ms`,
                  transform:
                    hovered === segment.id
                      ? `translate(${segment.dx}px, ${segment.dy}px)`
                      : undefined,
                } as CSSProperties
              }
              onPointerEnter={() => setHovered(segment.id)}
              onPointerLeave={() => setHovered(null)}
            />
          ))}
        </g>
        <text className={styles.centerValue} x={CENTER} y={CENTER + 2} textAnchor="middle" dominantBaseline="middle">
          {centerValue === null ? "—" : numberFormat.format(Math.round(centerValue))}
        </text>
        <text className={styles.centerLabel} x={CENTER} y={CENTER + 20} textAnchor="middle">
          {hoveredSlice ? hoveredSlice.label : centerLabel}
        </text>
      </svg>

      <ul className={styles.legend}>
        {segments.map((segment, index) => (
          <li
            key={segment.id}
            className={`${styles.legendItem} ${hovered === segment.id ? styles.legendItemActive : ""}`}
            onPointerEnter={() => setHovered(segment.id)}
            onPointerLeave={() => setHovered(null)}
          >
            <span
              className={styles.swatch}
              style={{ background: COLORS[index % COLORS.length] }}
              aria-hidden="true"
            />
            <span className={styles.legendLabel}>{segment.label}</span>
            <span className={styles.legendValue}>{numberFormat.format(segment.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
