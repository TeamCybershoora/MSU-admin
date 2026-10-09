/**
 * Activity mapping — turns real server events into feed items.
 *
 * The server (see @/lib/dashboard-analytics) returns only an event kind and a
 * timestamp plus non-personal context, so this mapper is the single place the
 * human wording lives. A missing timestamp degrades to no label rather than an
 * invented one.
 */

import { enquiryTypeLabel, formatRelativeTime } from "./format";
import type { ActivityItem, RecentActivity } from "./types";

export function toActivityItems(recent: RecentActivity[]): ActivityItem[] {
  return recent.map((event) => {
    const at = event.at ? formatRelativeTime(event.at) : undefined;

    switch (event.kind) {
      case "student":
        return {
          id: event.id,
          title: "New student account created",
          detail: "Registration submitted",
          at,
        };
      case "enquiry":
        return {
          id: event.id,
          title: "Enquiry received",
          detail: `${enquiryTypeLabel(event.detail)} enquiry`,
          at,
        };
      case "enrolment":
        return {
          id: event.id,
          title: "Student enrolled",
          detail: `Official identifiers issued ${
            event.detail === "on verification" ? "on approval" : "manually"
          }`,
          at,
        };
      default:
        return { id: event.id, title: "Administration activity", at };
    }
  });
}
