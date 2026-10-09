"use client";

/**
 * ActivityFeed — recent administration activity.
 *
 * Deliberately quiet: a leading accent dot, a title, optional detail and a
 * timestamp. Items enter with a small stagger; rows only fade slightly on hover.
 */

import type { CSSProperties } from "react";
import { STAGGER_MS } from "./motion";
import type { ActivityItem } from "./types";
import styles from "./activity-feed.module.css";

export default function ActivityFeed({
  items,
  emptyLabel = "No recent activity.",
}: {
  items: ActivityItem[];
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }

  return (
    <ul className={styles.list}>
      {items.map((item, index) => (
        <li
          key={item.id}
          className={styles.item}
          style={{ "--i": index, animationDelay: `${index * STAGGER_MS}ms` } as CSSProperties}
        >
          <span className={styles.dot} aria-hidden="true" />
          <div className={styles.text}>
            <span className={styles.title}>{item.title}</span>
            {item.detail && <span className={styles.detail}>{item.detail}</span>}
          </div>
          {item.at && <span className={styles.at}>{item.at}</span>}
        </li>
      ))}
    </ul>
  );
}
