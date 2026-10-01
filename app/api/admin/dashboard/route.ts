import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Student from "@/models/Student";
import Result from "@/models/Result";
import Syllabus from "@/models/Syllabus";
import College from "@/models/College";
import Enquiry from "@/models/Enquiry";
import { authenticateAdmin } from "@/lib/admin-auth";

/**
 * GET /api/admin/dashboard
 *
 * Returns dashboard statistics for the admin portal.
 * Protected: requires admin JWT.
 */

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    // Run counts in parallel for performance
    const [
      totalStudents,
      totalResults,
      totalSyllabi,
      totalColleges,
      newEnquiries,
      inReviewEnquiries,
      respondedEnquiries,
      closedEnquiries,
    ] = await Promise.all([
      Student.countDocuments(),
      Result.countDocuments(),
      Syllabus.countDocuments(),
      College.countDocuments(),
      // Enquiries created by the public MSU website, grouped by workflow status.
      Enquiry.countDocuments({ status: "new" }),
      Enquiry.countDocuments({ status: "in_review" }),
      Enquiry.countDocuments({ status: "responded" }),
      Enquiry.countDocuments({ status: "closed" }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        totalStudents,
        totalResults,
        totalSyllabi,
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
