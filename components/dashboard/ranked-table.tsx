"use client";

/**
 * RankedTable — a compact ranked list.
 *
 * Rows enter top→bottom (opacity 0→1, translateY 6→0, ~240 ms, ~55 ms stagger)
 * and each value counts up as its row arrives. Rows never move or scale on
 * hover — only a subtle background transition.
 *
 * The value count-up lives in a per-row child component because hooks cannot be
 * called inside a loop.
 */

import type { CSSProperties } from "react";
import { useCountUp } from "./hooks";
import { STAGGER_MS } from "./motion";
import type { RankedRow } from "./types";
import styles from "./ranked-table.module.css";

const numberFormat = new Intl.NumberFormat("en-IN");

function Row({
  row,
  rank,
  fraction,
  unit,
}: {
  row: RankedRow;
  rank: number;
  fraction: number;
  unit: string;
}) {
  const value = useCountUp(row.value, { startDelay: rank * STAGGER_MS });
  return (
    <li className={styles.row} style={{ "--i": rank } as CSSProperties}>
      <span className={styles.rank}>{rank + 1}</span>
      <div className={styles.main}>
        <div className={styles.line}>
          <span className={styles.label}>
            {row.label}
            {row.meta && <span className={styles.meta}>{row.meta}</span>}
          </span>
          <span className={styles.value}>
            {value === null ? "—" : numberFormat.format(Math.round(value))}
            <em>{unit}</em>
          </span>
        </div>
        <span className={styles.barTrack} aria-hidden="true">
          <span
            className={styles.barFill}
            style={{ transform: `scaleX(${Math.max(0.02, fraction)})` }}
          />
        </span>
      </div>
    </li>
  );
}

export default function RankedTable({
  rows,
  unit,
  emptyLabel = "No data available for this period.",
}: {
  rows: RankedRow[];
  unit: string;
  emptyLabel?: string;
}) {
  if (rows.length === 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }

  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <ul className={styles.list}>
      {rows.map((row, index) => (
        <Row
          key={row.id}
          row={row}
          rank={index}
          fraction={row.value / max}
          unit={unit}
        />
      ))}
    </ul>
  );
}
