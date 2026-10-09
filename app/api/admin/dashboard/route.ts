import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Student from "@/models/Student";
import Result from "@/models/Result";
import Syllabus from "@/models/Syllabus";
import ProgrammeSyllabus from "@/models/ProgrammeSyllabus";
import College from "@/models/College";
import Enquiry from "@/models/Enquiry";
import { authenticateAdmin } from "@/lib/admin-auth";
import { buildDashboardAnalytics } from "@/lib/dashboard-analytics";

/**
 * GET /api/admin/dashboard
 *
 * Returns dashboard statistics for the admin portal.
 * Protected: requires admin JWT.
 *
 * `?analytics=1` additionally returns the Super Admin dashboard's real
 * aggregates (see @/lib/dashboard-analytics) — daily registration / enquiry /
 * enrolment series, top colleges and programmes, application + enquiry status
 * distributions, district breakdowns and recent administrative activity.
 *
 * The flag exists because this endpoint doubles as the cheap auth probe the
 * admin shell calls on every route change; the aggregate queries must not run
 * on that path. The DEFAULT response is byte-for-byte unchanged.
 */

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  const wantsAnalytics = new URL(req.url).searchParams.get("analytics") === "1";

  try {
    await connectDB();

    // Run counts in parallel for performance
    const [
      totalStudents,
      totalResults,
      structuredSyllabus,
      programmeSyllabus,
      totalColleges,
      newEnquiries,
      inReviewEnquiries,
      respondedEnquiries,
      closedEnquiries,
    ] = await Promise.all([
      Student.countDocuments(),
      Result.countDocuments(),
      // Syllabus DOCUMENTS are stored in TWO layers of the same data model:
      //   Syllabus          → one document per programme + session + semester
      //   ProgrammeSyllabus → one official PDF per programme + session
      // A programme may legitimately have only the latter (a single official
      // "Complete Syllabus" PDF and no semester/subject documents), so both
      // layers must be counted — counting only `syllabuses` reported 0 for an
      // uploaded programme-wide syllabus.
      Syllabus.countDocuments(),
      ProgrammeSyllabus.countDocuments(),
      College.countDocuments(),
      // Enquiries created by the public MSU website, grouped by workflow status.
      Enquiry.countDocuments({ status: "new" }),
      Enquiry.countDocuments({ status: "in_review" }),
      Enquiry.countDocuments({ status: "responded" }),
      Enquiry.countDocuments({ status: "closed" }),
    ]);

    // Every persisted syllabus document, across both layers.
    const totalSyllabus = structuredSyllabus + programmeSyllabus;

    return NextResponse.json({
      success: true,
      data: {
        totalStudents,
        totalResults,
        totalSyllabus,
        // Breakdown so the total is verifiable at a glance.
        totalStructuredSyllabus: structuredSyllabus,
        totalProgrammeSyllabus: programmeSyllabus,
        totalColleges,
        // Counts only — enquiry contents are never part of a dashboard payload.
        enquiriesByStatus: {
          new: newEnquiries,
          in_review: inReviewEnquiries,
          responded: respondedEnquiries,
          closed: closedEnquiries,
        },
        // Placeholder fields — no data source exists yet
        totalFaculty: null,
        pendingApplications: null,
        upcomingExams: null,
        // Only computed when explicitly requested (see the doc comment).
        ...(wantsAnalytics ? { analytics: await buildDashboardAnalytics() } : {}),
      },
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load dashboard statistics." },
      { status: 500 }
    );
  }
}
