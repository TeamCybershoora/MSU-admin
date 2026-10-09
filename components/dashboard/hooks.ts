"use client";

/**
 * Small, dependency-free hooks for the dashboard's motion layer.
 *
 * Deliberately lean: the admin app ships no animation library, so these cover
 * the handful of behaviours that genuinely need JavaScript (number count-ups,
 * element measurement, scroll reveal, reduced-motion detection). Everything
 * else is done with CSS transitions/keyframes.
 *
 * All hooks read browser state through useSyncExternalStore or an async
 * observer callback — never by calling setState synchronously inside an effect
 * body — so they stay clear of the `react-hooks/set-state-in-effect` lint rule.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { COUNT_UP_MS, EASE } from "./motion";

/* ── Reduced motion ─────────────────────────────────────────────── */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * True when the visitor asked for reduced motion.
 *
 * Server/first-render snapshot is `false` so hydration matches the static HTML;
 * the real value arrives on the first client read.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    () => false
  );
}

/* ── Count-up ───────────────────────────────────────────────────── */

/**
 * Animate a number towards `target`, returning the value to display.
 *
 * Behaviour required by the brief:
 *   - mounts counting up from 0 (a card entrance),
 *   - when `target` later changes it interpolates from the CURRENT value toward
 *     the new one — it never resets to 0 and never replays the entrance,
 *   - under reduced motion it snaps straight to the final value,
 *   - `null` is passed straight through (used for "not available" metrics).
 *
 * `startDelay` lets a card's number begin after its entrance has started.
 */
export function useCountUp(
  target: number | null | undefined,
  options: { duration?: number; startDelay?: number } = {}
): number | null {
  const { duration = COUNT_UP_MS, startDelay = 0 } = options;
  const reduced = useReducedMotion();

  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (target === null || target === undefined) return;

    const to = target;

    // Reduced motion (or nothing to animate): jump via the frame loop so no
    // setState happens synchronously inside this effect.
    if (reduced || fromRef.current === to) {
      fromRef.current = to;
      frameRef.current = requestAnimationFrame(() => setDisplay(to));
      return () => {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      };
    }

    const from = fromRef.current;
    let start = 0;

    const tick = (now: number) => {
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / duration);
      const value = from + (to - from) * EASE.out(t);
      fromRef.current = value;
      setDisplay(value);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };

    timeoutRef.current = setTimeout(() => {
      frameRef.current = requestAnimationFrame(tick);
    }, startDelay);

    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration, startDelay, reduced]);

  return target === null || target === undefined ? null : display;
}

/* ── Element measurement ────────────────────────────────────────── */

/**
 * Track an element's content width (px) with a ResizeObserver.
 *
 * Used by the SVG charts so their internal coordinates are computed in real
 * pixels — a fixed viewBox would distort stroke widths and text.
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) < 0.5 ? prev : Math.round(next)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/* ── Scroll reveal ──────────────────────────────────────────────── */

/**
 * Reveal-on-scroll trigger. Fires once by default and then disconnects, so a
 * section never re-animates every time it scrolls back into view.
 */
export function useInView<T extends HTMLElement>(
  options: { once?: boolean; threshold?: number } = {}
) {
  const { once = true, threshold = 0.15 } = options;
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { threshold }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [once, threshold]);

  return [ref, inView] as const;
}

/* ── Outside click ──────────────────────────────────────────────── */

/**
 * Invoke `onOutside` when a pointer goes down outside the returned ref, or when
 * Escape is pressed. Used by the profile / notification dropdowns.
 *
 * `active` keeps the listeners detached while the surface is closed.
 */
export function useDismiss<T extends HTMLElement>(
  active: boolean,
  onOutside: () => void
) {
  const ref = useRef<T | null>(null);

  const handler = useCallback(
    (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") onOutside();
        return;
      }
      const el = ref.current;
      if (el && !el.contains(event.target as Node)) onOutside();
    },
    [onOutside]
  );

  useEffect(() => {
    if (!active) return;
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [active, handler]);

  return ref;
}
