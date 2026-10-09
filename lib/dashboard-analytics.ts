/**
 * Server-only read-only aggregates for the Super Admin dashboard.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The Super Admin dashboard must NOT display invented statistics (see the
 * dashboard brief: "do NOT fabricate university statistics"). Everything this
 * module returns is computed directly from records the admin application
 * already stores — it only READS, never writes.
 *
 * It is deliberately separate from `app/api/admin/dashboard/route.ts` so the
 * cheap totalling endpoint (also used on every admin route change for the auth
 * check) stays fast: these aggregations run only when the dashboard explicitly
 * asks for them (`?analytics=1`).
 *
 * CONTRACT
 * ────────
 * - Every aggregate is individually guarded: one failing query degrades to an
 *   empty collection instead of failing the whole payload, so a single bad
 *   dataset can never blank the dashboard.
 * - No credentials, tokens, password material or enquiry message content is
 *   ever selected. Enquiries contribute only their type/status/timestamp, and
 *   activity contributes only an event kind + timestamp.
 * - No PII beyond a college name (already shown in College Management) is
 *   returned.
 */

import connectDB from "@/lib/mongodb";
import Student from "@/models/Student";
import Enquiry from "@/models/Enquiry";
import College from "@/models/College";
import EnrollmentEvent from "@/models/EnrollmentEvent";

/** One day of an activity series, `date` as `YYYY-MM-DD` (UTC). */
export interface DailyCount {
  date: string;
  count: number;
}

export interface NamedCount {
  label: string;
  value: number;
}

export interface DistrictCount {
  /** College district, or "" when a record has no district assigned. */
  district: string;
  value: number;
}

export type RecentActivityKind = "student" | "enquiry" | "enrolment";

export interface RecentActivity {
  id: string;
  kind: RecentActivityKind;
  /** ISO timestamp of the event. */
  at: string;
  /** Optional non-personal context: enrolment action, or enquiry type. */
  detail?: string;
}

export interface DashboardAnalytics {
  /** Daily counts for the trailing window, gap-free dates are filled client-side. */
  series: {
    registrations: DailyCount[];
    enquiries: DailyCount[];
    enrolments: DailyCount[];
  };
  /** Registered students per college, highest first (top colleges). */
  topColleges: NamedCount[];
  /** Registered students per programme/course, highest first. */
  topProgrammes: NamedCount[];
  /** Students grouped by application status (legacy records read as verified). */
  applicationStatus: Record<string, number>;
  /** Enquiries grouped by workflow status — recomputed here for share maths. */
  enquiryStatus: Record<string, number>;
  /** Enquiries grouped by enquiry type. */
  enquiriesByType: NamedCount[];
  /** Students per district, resolved through their college's district. */
  studentsByDistrict: DistrictCount[];
  /** Affiliated colleges per district. */
  collegesByDistrict: DistrictCount[];
  /** Newest administrative events across the modules, newest first. */
  recentActivity: RecentActivity[];
  /** ISO timestamp the aggregates were computed. */
  generatedAt: string;
}

/** How many days of daily series to return (covers the 12-month range). */
const SERIES_WINDOW_DAYS = 365;

/** Never let one broken aggregate take the whole dashboard down. */
async function safe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error("Dashboard aggregate failed:", error);
    return fallback;
  }
}

/** Start of the trailing series window (UTC midnight, N days ago). */
function seriesWindowStart(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - SERIES_WINDOW_DAYS
    )
  );
}

/** A `$dateToString` grouped row. */
type DailyRow = { _id: string | null; count: number };
/** A grouped string value row. */
type ValueRow = { _id: string; value: number };

/**
 * Run an aggregation and normalise the result, swallowing failures.
 *
 * Takes a thunk so the pipeline can be written inline against the real Mongoose
 * model (`.exec()` keeps the return type a real Promise).
 */
function rows<T>(run: () => Promise<T[]>): Promise<T[]> {
  return safe(run, [] as T[]);
}

/** Daily counts of a collection's date field, gap-free handled by the client. */
async function dailySeries(
  run: () => Promise<DailyRow[]>
): Promise<DailyCount[]> {
  const result = await rows(run);
  return result
    .filter((row) => typeof row._id === "string")
    .map((row) => ({ date: row._id as string, count: row.count ?? 0 }));
}

/** Top-N most common values of a string field (skipping empty values). */
async function topValues(run: () => Promise<ValueRow[]>): Promise<NamedCount[]> {
  const result = await rows(run);
  return result.map((row) => ({ label: row._id, value: row.value ?? 0 }));
}

/**
 * Build every Super Admin aggregate.
 *
 * All queries are read-only and run in parallel. The caller has already
 * authenticated the request (see the dashboard route) — this module performs
 * no authorization of its own and must never be called before `authenticateAdmin`.
 */
export async function buildDashboardAnalytics(): Promise<DashboardAnalytics> {
  await connectDB();

  const since = seriesWindowStart();

  const [
    registrations,
    enquiries,
    enrolments,
    topColleges,
    topProgrammes,
    applicationStatusRows,
    enquiryStatusRows,
    enquiriesByType,
    studentsByDistrict,
    collegesByDistrict,
    recentActivity,
  ] = await Promise.all([
    dailySeries(() =>
      Student.aggregate<DailyRow>([
        { $match: { registeredAt: { $gte: since } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$registeredAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec()
    ),
    dailySeries(() =>
      Enquiry.aggregate<DailyRow>([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec()
    ),
    dailySeries(() =>
      EnrollmentEvent.aggregate<DailyRow>([
        { $match: { at: { $gte: since } } },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "UTC" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec()
    ),

    topValues(() =>
      Student.aggregate<ValueRow>([
        { $match: { college: { $nin: [null, ""] } } },
        { $group: { _id: "$college", value: { $sum: 1 } } },
        { $sort: { value: -1 } },
        { $limit: 6 },
      ]).exec()
    ),
    topValues(() =>
      Student.aggregate<ValueRow>([
        { $match: { course: { $nin: [null, ""] } } },
        { $group: { _id: "$course", value: { $sum: 1 } } },
        { $sort: { value: -1 } },
        { $limit: 6 },
      ]).exec()
    ),

    rows(() =>
      // Legacy student documents carry no applicationStatus and are treated as
      // already verified throughout the admin app — mirrored here so the
      // distribution matches what the review screens show.
      Student.aggregate<ValueRow>([
        {
          $group: {
            _id: { $ifNull: ["$applicationStatus", "verified"] },
            value: { $sum: 1 },
          },
        },
      ]).exec()
    ),

    rows(() =>
      Enquiry.aggregate<ValueRow>([
        { $group: { _id: "$status", value: { $sum: 1 } } },
      ]).exec()
    ),

    topValues(() =>
      Enquiry.aggregate<ValueRow>([
        { $match: { type: { $nin: [null, ""] } } },
        { $group: { _id: "$type", value: { $sum: 1 } } },
        { $sort: { value: -1 } },
        { $limit: 6 },
      ]).exec()
    ),

    rows(async () => {
      // Students store a college NAME, so the district is resolved through the
      // College collection. Names that do not match a college are reported as
      // "" (unassigned) rather than being guessed at.
      const result = await Student.aggregate<ValueRow>([
        { $match: { college: { $nin: [null, ""] } } },
        {
          $lookup: {
            from: "colleges",
            localField: "college",
            foreignField: "collegeName",
            as: "collegeDoc",
          },
        },
        { $unwind: { path: "$collegeDoc", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $ifNull: ["$collegeDoc.district", ""] },
            value: { $sum: 1 },
          },
        },
        { $sort: { value: -1 } },
      ]).exec();

      return result.map((row) => ({
        district: row._id ?? "",
        value: row.value ?? 0,
      }));
    }),

    rows(async () => {
      const result = await College.aggregate<ValueRow>([
        { $group: { _id: { $ifNull: ["$district", ""] }, value: { $sum: 1 } } },
        { $sort: { value: -1 } },
      ]).exec();

      return result.map((row) => ({
        district: row._id ?? "",
        value: row.value ?? 0,
      }));
    }),

    safe<RecentActivity[]>(async () => {
      const [students, enquiryDocs, enrolmentDocs] = await Promise.all([
        Student.find({})
          .sort({ registeredAt: -1 })
          .limit(6)
          .select({ _id: 1, registeredAt: 1 })
          .lean(),
        Enquiry.find({})
          .sort({ createdAt: -1 })
          .limit(6)
          .select({ _id: 1, createdAt: 1, type: 1 })
          .lean(),
        EnrollmentEvent.find({})
          .sort({ at: -1 })
          .limit(6)
          .select({ _id: 1, at: 1, action: 1, admissionYear: 1 })
          .lean(),
      ]);

      const merged: RecentActivity[] = [];

      for (const doc of students) {
        const at = doc.registeredAt ? new Date(doc.registeredAt) : null;
        if (at) {
          merged.push({ id: `student:${doc._id}`, kind: "student", at: at.toISOString() });
        }
      }
      for (const doc of enquiryDocs) {
        const at = doc.createdAt ? new Date(doc.createdAt) : null;
        if (at) {
          merged.push({
            id: `enquiry:${doc._id}`,
            // Only the type — never the message or the submitter's details.
            kind: "enquiry",
            at: at.toISOString(),
            detail: doc.type,
          });
        }
      }
      for (const doc of enrolmentDocs) {
        const at = doc.at ? new Date(doc.at) : null;
        if (at) {
          merged.push({
            id: `enrolment:${doc._id}`,
            kind: "enrolment",
            at: at.toISOString(),
            detail: doc.action === "assigned_on_verification" ? "on verification" : "manual",
          });
        }
      }

      merged.sort((a, b) => (a.at < b.at ? 1 : -1));
      return merged.slice(0, 7);
    }, []),
  ]);

  const toRecord = (rows: Array<{ _id: string; value: number }>) =>
    rows.reduce<Record<string, number>>((acc, row) => {
      if (row._id) acc[row._id] = row.value ?? 0;
      return acc;
    }, {});

  return {
    series: { registrations, enquiries, enrolments },
    topColleges,
    topProgrammes,
    applicationStatus: toRecord(applicationStatusRows),
    enquiryStatus: toRecord(enquiryStatusRows),
    enquiriesByType,
    studentsByDistrict,
    collegesByDistrict,
    recentActivity,
    generatedAt: new Date().toISOString(),
  };
}
