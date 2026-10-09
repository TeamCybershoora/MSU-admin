/**
 * Dashboard motion tokens (JavaScript side).
 *
 * Mirrors the CSS tokens in app/globals.css (`--dur-*`, `--ease-*`) so the few
 * animations that must run in JS (number count-ups, staggered values) use the
 * SAME scale as the CSS transitions instead of inventing ad-hoc durations.
 *
 * The scale follows the project brief:
 *   FAST 100–150 · SHORT 150–250 · MEDIUM 250–400 · LONG 500–900
 *   DATA 700–1200 · CHART 1000–1600
 */

export const MOTION_MS = {
  fast: 120,
  short: 200,
  medium: 320,
  long: 620,
  data: 900,
  chart: 1200,
} as const;

/** Stagger between sibling metric cards / table rows. */
export const STAGGER_MS = 70;

/** Duration of a metric number count-up (brief: ~500–600 ms). */
export const COUNT_UP_MS = 560;

/** Duration of the donut ring sweep, mirrored by its centre count-up. */
export const DONUT_SWEEP_MS = 820;

/** Line-chart draw-in (brief: ~700–900 ms). */
export const LINE_DRAW_MS = 820;

/** Ambient chart tooltip: one full left→right glide (brief: ~6–8 s). */
export const AMBIENT_GLIDE_MS = 7000;

/**
 * Standard easing curves, matching the CSS ease tokens. Exposed as functions so
 * JS animations are identical to the CSS ones.
 */
export const EASE = {
  out: (t: number) => 1 - Math.pow(1 - t, 3), // cubic-bezier(0.22, 1, 0.36, 1) approximation
  in: (t: number) => t * t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
} as const;
