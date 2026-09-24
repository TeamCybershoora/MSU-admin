import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Student, { toSafeStudent } from "@/models/Student";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { escapeRegex } from "@/lib/validation";

/**
 * GET /api/admin/students
 *
 * List, search, and filter students.
 * Query params: search, course, status, page, limit
 * Protected: requires admin JWT.
 */

const adminStudentLimiter = createRateLimiter({
  name: "admin-students",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStudentLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const search = url.searchParams.get("search")?.trim() || "";
    const course = url.searchParams.get("course")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    // Build query
    const query: Record<string, unknown> = {};

    if (search) {
      query.$or = [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { email: { $regex: escapeRegex(search), $options: "i" } },
        { username: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    if (course) {
      query.course = { $regex: escapeRegex(course), $options: "i" };
    }

    const [students, total] = await Promise.all([
      Student.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Student.countDocuments(query),
    ]);

    // Get unique courses for filter dropdown
    const courses = await Student.distinct("course");

    return NextResponse.json({
      success: true,
      data: students.map((s) => ({
        id: s._id,
        name: s.name,
        email: s.email,
        username: s.username,
        course: s.course,
        college: s.college,
        phone: s.phone,
        registeredAt: s.registeredAt,
        createdAt: s.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        courses: courses.sort(),
      },
    });
  } catch (error) {
    console.error("Admin students list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load students." },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/students
 *
 * Update a student's allowed fields.
 * Body: { studentId, name, course, college, phone }
 * Protected: requires admin JWT.
 */
export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { studentId, name, course, college, phone } = body;

    if (!studentId || typeof studentId !== "string") {
      return NextResponse.json(
        { success: false, message: "Student ID is required." },
        { status: 400 }
      );
    }

    const student = await Student.findById(studentId);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "Student not found." },
        { status: 404 }
      );
    }

    // Update only provided fields
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return NextResponse.json(
          { success: false, message: "Name cannot be empty." },
          { status: 400 }
        );
      }
      student.name = name.trim();
    }

    if (course !== undefined) {
      if (typeof course !== "string" || !course.trim()) {
        return NextResponse.json(
          { success: false, message: "Course cannot be empty." },
          { status: 400 }
        );
      }
      student.course = course.trim();
    }

    if (college !== undefined) {
      if (typeof college !== "string" || !college.trim()) {
        return NextResponse.json(
          { success: false, message: "College cannot be empty." },
          { status: 400 }
        );
      }
      student.college = college.trim();
    }

    if (phone !== undefined) {
      if (typeof phone !== "string" || !/^\d{10}$/.test(phone.trim())) {
        return NextResponse.json(
          { success: false, message: "Phone must be exactly 10 digits." },
          { status: 400 }
        );
      }
      student.phone = phone.trim();
    }

    await student.save();

    return NextResponse.json({
      success: true,
      message: "Student updated successfully.",
      student: toSafeStudent(student),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      errors?: Record<string, { message: string }>;
    };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin student update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update student." },
      { status: 500 }
    );
  }
}
