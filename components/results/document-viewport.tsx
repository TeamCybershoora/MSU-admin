"use client";

/**
 * DocumentViewport — fits the fixed-size Statement of Marks page into the
 * available width.
 *
 * The statement is an exact A4 canvas, so it must never be re-flowed or
 * resized: doing so would change the page proportions and the print output.
 * Instead the page is scaled uniformly with a CSS transform, which keeps the
 * ornament undistorted, and the wrapper reserves the scaled height so no
 * phantom scroll space appears.
 *
 * The document declares its own size in millimetres (210 x 297 mm), so the
 * natural size is MEASURED from the scaled element rather than assumed:
 * `offsetWidth` / `offsetHeight` are layout values and, unlike
 * `getBoundingClientRect()`, they ignore the CSS transform — which is exactly
 * the untransformed page size needed for the scale factor.
 *
 * The transform is disabled for print (see the stylesheet), where the document
 * must be rendered at true size.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import styles from "./document-viewport.module.css";

/** Fallback A4 height at 96dpi, used until the first measurement lands. */
const FALLBACK_PAGE_HEIGHT = 1123;

interface DocumentViewportProps {
  children: ReactNode;
  className?: string;
}

export default function DocumentViewport({ children, className = "" }: DocumentViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scalerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pageHeight, setPageHeight] = useState(FALLBACK_PAGE_HEIGHT);

  useEffect(() => {
    const container = containerRef.current;
    const scaler = scalerRef.current;
    if (!container || !scaler) return;

    const measure = () => {
      const naturalWidth = scaler.offsetWidth;
      const naturalHeight = scaler.offsetHeight;
      if (!naturalWidth) return;

      const available = container.clientWidth;
      // Never scale above 1: the statement is legible at its natural size.
      const nextScale = available > 0 ? Math.min(1, available / naturalWidth) : 1;

      // Guarded updates: the ResizeObserver fires when the wrapper's reserved
      // height changes, and re-setting an identical value would loop.
      setScale((previous) => (Math.abs(previous - nextScale) < 0.0005 ? previous : nextScale));
      setPageHeight((previous) => (previous === naturalHeight ? previous : naturalHeight));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={`${styles.viewport} ${className}`}
      style={{ height: Math.round(pageHeight * scale) }}
    >
      <div ref={scalerRef} className={styles.scaler} style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
