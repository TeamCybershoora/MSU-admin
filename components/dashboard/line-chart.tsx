"use client";

/**
 * LineChart — a dependency-free SVG analytics chart.
 *
 * Load choreography (per the brief):
 *   1. the card frame fades in        (handled by ChartCard)
 *   2. axes / grid labels appear
 *   3. the line draws left → right    (~820 ms, stroke-dashoffset via pathLength)
 *   4. the area fill fades in just after the line
 *   5. an ambient tooltip begins gliding
 *
 * Interaction:
 *   - ONE `<ChartTooltip>` component renders both the ambient and the pointer
 *     tooltip (no second visual system).
 *   - Moving the pointer pauses the ambient glide immediately, hands control to
 *     the pointer and highlights the nearest point; leaving resumes it.
 *
 * Performance:
 *   - the continuous ambient glide is written straight to refs inside a single
 *     rAF loop — no per-frame React re-renders,
 *   - the pointer tooltip uses ordinary state + a CSS transition,
 *   - the loop has NO visible jump: the tooltip fades out, resets while hidden,
 *     then fades back in.
 *
 * Reduced motion: the line renders fully drawn, the fill is visible and the
 * ambient glide never starts (pointer interaction still works).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useElementWidth, useReducedMotion } from "./hooks";
import { AMBIENT_GLIDE_MS } from "./motion";
import type { SeriesPoint } from "./types";
import styles from "./line-chart.module.css";

const PAD = { left: 46, right: 18, top: 18, bottom: 30 };
const TENSION = 0.18;

const numberFormat = new Intl.NumberFormat("en-IN");

/** Round a maximum up to a visually pleasant axis ceiling. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const f = value / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}

/** Catmull-Rom → cubic-Bezier smoothing (smooth without big overshoot). */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * TENSION;
    const c1y = p1.y + (p2.y - p0.y) * TENSION;
    const c2x = p2.x - (p3.x - p1.x) * TENSION;
    const c2y = p2.y - (p3.y - p1.y) * TENSION;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function ChartTooltip({
  x,
  y,
  label,
  value,
  valueLabel,
  animated,
}: {
  x: number;
  y: number;
  label: string;
  value: number;
  valueLabel: string;
  animated?: boolean;
}) {
  return (
    <div
      className={`${styles.tooltip} ${animated ? styles.tooltipAnimated : ""}`}
      style={{ transform: `translate(${x}px, ${y}px)` }}
    >
      <div className={styles.tooltipInner}>
        <span className={styles.tooltipLabel}>{label}</span>
        <span className={styles.tooltipValue}>
          {numberFormat.format(value)} <em>{valueLabel}</em>
        </span>
      </div>
    </div>
  );
}

interface LineChartProps {
  points: SeriesPoint[];
  valueLabel: string;
  height?: number;
  /** Changing this replays the draw animation (used for range changes). */
  replayKey?: string;
}

export default function LineChart({
  points,
  valueLabel,
  height = 300,
  replayKey = "default",
}: LineChartProps) {
  const reduced = useReducedMotion();
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  // Responsive height: a phone-width chart is shorter so it never dominates the
  // viewport. `height` stays the desktop/laptop ceiling.
  const chartHeight = useMemo(() => {
    if (width === 0) return height;
    if (width < 360) return Math.min(height, 200);
    if (width < 480) return Math.min(height, 240);
    if (width < 700) return Math.min(height, 280);
    return height;
  }, [width, height]);

  // Pointer interaction state (null = no pointer on the chart).
  const [pointerIndex, setPointerIndex] = useState<number | null>(null);
  // Ambient layer visibility (faded during the loop reset).
  const [ambientVisible, setAmbientVisible] = useState(false);

  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ambient refs — written directly by the rAF loop (no re-render).
  const ambientGuideRef = useRef<HTMLSpanElement | null>(null);
  const ambientDotRef = useRef<HTMLSpanElement | null>(null);
  const ambientTipRef = useRef<HTMLDivElement | null>(null);
  const ambientLabelRef = useRef<HTMLSpanElement | null>(null);
  const ambientValueRef = useRef<HTMLSpanElement | null>(null);

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = Math.max(1, chartHeight - PAD.top - PAD.bottom);

  const geometry = useMemo(() => {
    const values = points.map((p) => p.value);
    const maxV = niceCeil(Math.max(1, ...values));
    const lastIndex = Math.max(1, points.length - 1);
    const xAt = (i: number) => PAD.left + (i / lastIndex) * innerW;
    const yAt = (v: number) => PAD.top + (1 - v / maxV) * innerH;
    const coords = points.map((p, i) => ({ x: xAt(i), y: yAt(p.value) }));
    const linePath = smoothPath(coords);
    const baseline = PAD.top + innerH;
    const areaPath =
      coords.length > 0
        ? `${linePath} L ${coords[coords.length - 1].x} ${baseline} L ${coords[0].x} ${baseline} Z`
        : "";
    return { maxV, xAt, yAt, coords, linePath, areaPath, baseline };
  }, [points, innerW, innerH]);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * geometry.maxV);

  // Show a fixed number of x labels so they never crowd.
  const xLabelStep = Math.max(1, Math.ceil(points.length / 6));

  const ready = width > 0 && points.length > 0;
  const ambientOn = ready && !reduced && pointerIndex === null;

  // ── Ambient glide ────────────────────────────────────────────────
  useEffect(() => {
    if (!ambientOn) return;

    const lastIndex = Math.max(1, points.length - 1);
    const { xAt, yAt } = geometry;
    let raf = 0;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    let start = 0;

    const write = (index: number, frac = 0) => {
      const i0 = Math.min(points.length - 1, Math.floor(index));
      const i1 = Math.min(points.length - 1, i0 + 1);
      const x = xAt(i0) + (xAt(i1) - xAt(i0)) * frac;
      const y = yAt(points[i0].value) + (yAt(points[i1].value) - yAt(points[i0].value)) * frac;

      if (ambientGuideRef.current) {
        ambientGuideRef.current.style.transform = `translateX(${x}px)`;
      }
      if (ambientDotRef.current) {
        ambientDotRef.current.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (ambientTipRef.current) {
        ambientTipRef.current.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (ambientLabelRef.current) {
        ambientLabelRef.current.textContent = points[i0].label;
      }
      if (ambientValueRef.current) {
        ambientValueRef.current.textContent = numberFormat.format(points[i0].value);
      }
    };

    const step = (now: number) => {
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / AMBIENT_GLIDE_MS);
      const pos = t * lastIndex;
      const i0 = Math.min(points.length - 1, Math.floor(pos));
      write(pos, pos - i0);

      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        // Loop without a visible jump: fade out, reset while hidden, fade in.
        setAmbientVisible(false);
        resetTimer = setTimeout(() => {
          start = 0;
          write(0, 0);
          setAmbientVisible(true);
          raf = requestAnimationFrame(step);
        }, 260);
      }
    };

    // Show the ambient layer inside the frame callback (never synchronously in
    // the effect body). Visibility is also gated by `ambientOn` at render time,
    // so no cleanup setState is needed.
    write(0, 0);
    raf = requestAnimationFrame((now) => {
      setAmbientVisible(true);
      step(now);
    });

    return () => {
      cancelAnimationFrame(raf);
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, [ambientOn, geometry, points]);

  // Clear the pending "resume" timer on unmount.
  useEffect(
    () => () => {
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    },
    []
  );

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!ready) return;
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = (x - PAD.left) / innerW;
    const index = Math.round(ratio * (points.length - 1));
    setPointerIndex(Math.min(points.length - 1, Math.max(0, index)));
  }

  function handlePointerLeave() {
    // Brief pause before the ambient glide resumes.
    resumeTimer.current = setTimeout(() => setPointerIndex(null), 700);
  }

  const active = pointerIndex !== null ? points[pointerIndex] : null;
  const activeX = pointerIndex !== null ? geometry.xAt(pointerIndex) : 0;
  const activeY = pointerIndex !== null ? geometry.yAt(points[pointerIndex].value) : 0;

  return (
    <div
      ref={containerRef}
      className={styles.wrap}
      style={{ height: chartHeight }}
    >
      {ready && (
        <>
          <svg
            className={styles.svg}
            width={width}
            height={chartHeight}
            role="img"
            aria-label={`${valueLabel} chart`}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
          >
            {/* Grid + y-axis labels */}
            <g className={styles.grid}>
              {ticks.map((tick, i) => {
                const y = geometry.yAt(tick);
                return (
                  <g key={i}>
                    <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
                    <text x={PAD.left - 10} y={y} className={styles.axisText} textAnchor="end" dominantBaseline="middle">
                      {numberFormat.format(Math.round(tick))}
                    </text>
                  </g>
                );
              })}
            </g>

            {/* x-axis labels */}
            <g className={styles.grid}>
              {points.map((point, i) =>
                i % xLabelStep === 0 || i === points.length - 1 ? (
                  <text
                    key={i}
                    x={geometry.xAt(i)}
                    y={chartHeight - 8}
                    className={styles.axisText}
                    textAnchor="middle"
                  >
                    {point.label}
                  </text>
                ) : null
              )}
            </g>

            {/* Area fill — fades in just after the line starts drawing */}
            <path
              key={`area-${replayKey}`}
              d={geometry.areaPath}
              className={styles.area}
            />

            {/* The line — drawn left→right via normalized pathLength */}
            <path
              key={`line-${replayKey}`}
              d={geometry.linePath}
              className={styles.line}
              pathLength={1}
            />

            {/* Base data points (subtle) */}
            <g className={styles.points}>
              {geometry.coords.map((coord, i) => (
                <circle key={i} cx={coord.x} cy={coord.y} r={2.6} />
              ))}
            </g>
          </svg>

          {/* ── Ambient layer (ref-driven, no re-render) ── */}
          <div
            className={`${styles.ambient} ${ambientVisible && ambientOn ? styles.visible : ""}`}
            aria-hidden="true"
          >
            <span ref={ambientGuideRef} className={styles.guide} />
            <span ref={ambientDotRef} className={styles.activeDot} />
            <div ref={ambientTipRef} className={styles.tooltip}>
              <div className={styles.tooltipInner}>
                <span ref={ambientLabelRef} className={styles.tooltipLabel} />
                <span className={styles.tooltipValue}>
                  <span ref={ambientValueRef} />
                  <em> {valueLabel}</em>
                </span>
              </div>
            </div>
          </div>

          {/* ── Pointer layer (state-driven, animated) ── */}
          {active && (
            <div className={styles.pointerLayer} aria-hidden="true" style={{ "--x": activeX, "--y": activeY } as CSSProperties}>
              <span className={styles.guideActive} style={{ transform: `translateX(${activeX}px)` }} />
              <span className={styles.activeDot} style={{ transform: `translate(${activeX}px, ${activeY}px)` }} />
              <ChartTooltip
                x={activeX}
                y={activeY}
                label={active.label}
                value={active.value}
                valueLabel={valueLabel}
                animated
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
