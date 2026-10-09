"use client";

/**
 * Reveal — fades a section up the first time it scrolls into view.
 * Fires once (the observer disconnects) so a section never re-animates.
 */

import type { ReactNode } from "react";
import { useInView } from "./hooks";
import styles from "./reveal.module.css";

export default function Reveal({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className={`${styles.reveal} ${inView ? styles.in : ""} ${className}`}>
      {children}
    </div>
  );
}
