/**
 * Client-safe leadership role definitions.
 *
 * Deliberately free of mongoose so the browser UI, the API routes and the model
 * all share ONE source of truth for the controlled role values. Importing the
 * model from a client component would pull mongoose into the browser bundle.
 *
 * Leadership positions are FIXED: the admin can only manage the Chancellor and
 * the Vice Chancellor. There is no admin-created role and no admin-entered
 * profile route.
 */

/** The fixed leadership positions, in the order they appear on the homepage. */
export const LEADERSHIP_ROLES = ["chancellor", "vice-chancellor"] as const;

export type LeadershipRole = (typeof LEADERSHIP_ROLES)[number];

/** Human-readable labels for the admin UI. */
export const LEADERSHIP_ROLE_LABELS: Record<LeadershipRole, string> = {
  chancellor: "Chancellor",
  "vice-chancellor": "Vice Chancellor",
};

/** Type guard for a role value coming from a request body. */
export function isLeadershipRole(value: unknown): value is LeadershipRole {
  return (
    typeof value === "string" &&
    (LEADERSHIP_ROLES as readonly string[]).includes(value)
  );
}
