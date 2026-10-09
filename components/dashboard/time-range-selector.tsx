"use client";

/**
 * TimeRangeSelector — segmented control whose active pill GLIDES between
 * options instead of changing background instantly.
 *
 * The indicator is a single absolutely-positioned element moved with a
 * `transform` (GPU-friendly) driven by two CSS custom properties, so the slide
 * is one compositor transition rather than a per-button repaint.
 */

import type { CSSProperties } from "react";
import type { RangeKey } from "./types";
import styles from "./time-range-selector.module.css";

interface TimeRangeSelectorProps {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
  options: ReadonlyArray<{ key: RangeKey; label: string }>;
  ariaLabel?: string;
}

export default function TimeRangeSelector({
  value,
  onChange,
  options,
  ariaLabel = "Time range",
}: TimeRangeSelectorProps) {
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.key === value)
  );

  return (
    <div
      className={styles.wrap}
      role="tablist"
      aria-label={ariaLabel}
      style={
        {
          "--count": options.length,
          "--active": activeIndex,
        } as CSSProperties
      }
    >
      <span className={styles.indicator} aria-hidden="true" />
      {options.map((option) => {
        const isActive = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`${styles.option} ${isActive ? styles.active : ""}`}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
