/**
 * Small display formatters shared by the dashboard view models.
 *
 * Everything here is presentation-only — no data is invented, only labelled.
 */

/** Compact relative time for real timestamps ("Today", "3 days ago", "12 Mar"). */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const now = new Date();
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.floor((startOfToday - then.getTime()) / 86_400_000);

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(then);
}

/** Percentage of `part` out of `total`, rounded; `null` when undefined. */
export function percentageOf(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((part / total) * 100);
}

/** Human label for a college district value ("" → "Unassigned"). */
export function districtLabel(district: string): string {
  return district && district.trim() ? district : "Unassigned";
}

const ENQUIRY_TYPE_LABELS: Record<string, string> = {
  admission: "Admission",
  affiliation: "College registration",
  general: "General",
};

/** Human label for a stored enquiry `type` slug. */
export function enquiryTypeLabel(type: string | undefined): string {
  if (!type) return "Enquiry";
  return ENQUIRY_TYPE_LABELS[type] ?? type;
}
