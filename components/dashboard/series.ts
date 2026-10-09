/**
 * Series bucketing — turns a real daily count stream into the shape the
 * LineChart renders for one time range.
 *
 * The server sends one entry per day that had activity across the trailing
 * 12 months (see @/lib/dashboard-analytics). Days with no activity are filled
 * with a genuine 0 here — a real zero, never invented data.
 *
 * Buckets per range (matching the brief's 30 Days / 90 Days / 6 Months /
 * 12 Months options):
 *   30d  → 30 daily points
 *   90d  → 13 weekly points
 *   6m   → 6 monthly points
 *   12m  → 12 monthly points
 */

import type { DailyCount, RangeKey, SeriesPoint } from "./types";

const DAY_MS = 86_400_000;

const dayFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const monthFmt = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/** `YYYY-MM-DD` in UTC. */
function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM` in UTC. */
function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Midnight UTC today. */
function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Sum a set of daily keys into one bucket. */
function sumKeys(
  counts: Map<string, number>,
  keys: string[],
  kind: "day" | "month"
): number {
  let total = 0;
  for (const key of keys) {
    if (kind === "day") {
      total += counts.get(key) ?? 0;
    } else {
      // Roll every day of that month up.
      for (const [dayKey, value] of counts) {
        if (dayKey.startsWith(key)) total += value;
      }
    }
  }
  return total;
}

/**
 * Build the chart series for one range from a real daily count stream.
 *
 * Returns an empty array only when the range produces no buckets (never on a
 * real all-zero dataset — those render as a flat, honest zero line).
 */
export function buildSeries(daily: DailyCount[], range: RangeKey): SeriesPoint[] {
  const counts = new Map<string, number>();
  for (const point of daily) {
    if (point?.date) counts.set(point.date, (counts.get(point.date) ?? 0) + point.count);
  }

  const today = utcToday();
  const points: SeriesPoint[] = [];

  if (range === "30d" || range === "90d") {
    const bucketDays = range === "30d" ? 1 : 7;
    const buckets = range === "30d" ? 30 : 13;

    for (let i = buckets - 1; i >= 0; i--) {
      const end = new Date(today.getTime() - i * bucketDays * DAY_MS);
      const start = new Date(end.getTime() - (bucketDays - 1) * DAY_MS);

      const keys: string[] = [];
      for (let d = 0; d < bucketDays; d++) {
        keys.push(dateKey(new Date(start.getTime() + d * DAY_MS)));
      }

      points.push({
        label: dayFmt.format(start),
        value: sumKeys(counts, keys, "day"),
      });
    }

    return points;
  }

  const months = range === "6m" ? 6 : 12;
  for (let i = months - 1; i >= 0; i--) {
    const bucketDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const month = monthKey(bucketDate);

    // Sum every recorded day that falls inside this calendar month.
    let value = 0;
    for (const [dayKey, dayValue] of counts) {
      if (dayKey.startsWith(month)) value += dayValue;
    }

    points.push({ label: monthFmt.format(bucketDate), value });
  }

  return points;
}

/** True when a series has no recorded activity at all (all buckets zero). */
export function isSeriesEmpty(points: SeriesPoint[]): boolean {
  return points.length === 0 || points.every((point) => point.value === 0);
}
