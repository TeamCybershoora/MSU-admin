"use client";

/**
 * ChartCard — the shared frame for every chart / table / feed section.
 *
 * Keeping one frame means the whole screen shares a single radius, padding,
 * border and hover behaviour, and gives the load choreography one consistent
 * "frame fades in" starting point.
 */

import type { ReactNode } from "react";
import styles from "./chart-card.module.css";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  /** Control slot — e.g. the time-range selector. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function ChartCard({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: ChartCardProps) {
  return (
    <section className={`${styles.card} ${className}`}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h3 className={styles.title}>{title}</h3>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
