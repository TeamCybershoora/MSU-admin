import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Student, { toSafeStudent } from "@/models/Student";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  escapeRegex,
  isDeleteConfirmationValid,
  parseStudentStatus,
} from "@/lib/validation";

/**
 * GET /api/admin/students
 *
 * List, search, and filter students.
 * Query params: search, course, status, page, limit
 *   status: "ACTIVE" | "INACTIVE" — omitted = ALL (the existing default).
 * Protected: requires admin JWT.
 */

const adminStudentLimiter = createRateLimiter({
  name: "admin-students",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

// Mutations (update / activate-deactivate / permanent delete) share one
// per-IP budget, following the project's existing limiter pattern.
const adminStudentMutationLimiter = createRateLimiter({
  name: "admin-students-mutation",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

/** Shared 429 body for a rate-limited mutation. */
function rateLimited() {
  return NextResponse.json(
    { success: false, message: "Too many requests. Please try again later." },
    { status: 429 }
  );
}

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
    const rawStatus = url.searchParams.get("status")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    // Conditions are AND-ed together so a search term and a status filter can
    // both apply without one overwriting the other's `$or`.
    const conditions: Record<string, unknown>[] = [];

    if (search) {
      conditions.push({
        $or: [
          { name: { $regex: escapeRegex(search), $options: "i" } },
          { email: { $regex: escapeRegex(search), $options: "i" } },
          { username: { $regex: escapeRegex(search), $options: "i" } },
        ],
      });
    }

    if (course) {
      conditions.push({ course: { $regex: escapeRegex(course), $options: "i" } });
    }

    // Default (omitted / invalid) = ALL students, preserving the existing list.
    const status = rawStatus ? parseStudentStatus(rawStatus) : null;
    if (status === "INACTIVE") {
      conditions.push({ status: "INACTIVE" });
    } else if (status === "ACTIVE") {
      // Documents created before `status` existed carry no value but are ACTIVE.
      conditions.push({
        $or: [{ status: "ACTIVE" }, { status: { $exists: false } }],
      });
    }

    const query: Record<string, unknown> =
      conditions.length > 0 ? { $and: conditions } : {};

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
        // Lean results do not apply schema defaults, so a legacy doc reads as ACTIVE.
        status: s.status ?? "ACTIVE",
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

  if (adminStudentMutationLimiter.check(req)) return rateLimited();

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

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Student ID format." },
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

/**
 * PATCH /api/admin/students
 *
 * Activate or deactivate a student account. Mirrors the Admin status route.
 *
 * Body: { studentId, status: "ACTIVE" | "INACTIVE" }
 * - The student document is kept; only `status` changes.
 * - Fields, Results and every other record are untouched.
 * - Setting the status it already has is an idempotent success.
 * Protected: requires admin JWT.
 */
export async function PATCH(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStudentMutationLimiter.check(req)) return rateLimited();

  try {
    await connectDB();

    const body = await req.json();
    const { studentId, status: rawStatus } = (body ?? {}) as Record<string, unknown>;

    if (!studentId || typeof studentId !== "string") {
      return NextResponse.json(
        { success: false, message: "Student ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Student ID format." },
        { status: 400 }
      );
    }

    // Never trust the client's status value.
    const status = parseStudentStatus(rawStatus);
    if (!status) {
      return NextResponse.json(
        { success: false, message: "Status must be either \"ACTIVE\" or \"INACTIVE\"." },
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

    student.status = status;
    await student.save();

    return NextResponse.json({
      success: true,
      message:
        status === "ACTIVE" ? "Student activated." : "Student deactivated.",
      student: toSafeStudent(student),
    });
  } catch (error) {
    console.error("Admin student status error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update student status." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/students
 *
 * Permanently remove a single student document (hard delete).
 *
 * Body: { studentId, confirmEmail }
 * - `confirmEmail` must equal the student's email (case-insensitive); the
 *   server validates it — the confirmation dialog alone is never trusted.
 * - Only the requested student is removed. Nothing else is touched: no Result,
 *   Enquiry, ProgrammeStructure or Syllabus document is modified or deleted.
 *
 * Result dependency: Results embed a student snapshot (name/rollNumber/
 * enrollmentNumber/course/…) and do NOT reference the Student document by id,
 * and Student carries no matching identity field. There is therefore no
 * reliable Student ↔ Result relationship today, so no dependency check is
 * enforced here — guessing from free-text name/course would be unsound. Wiring
 * Student ↔ Result together is a separate phase.
 *
 * Protected: requires admin JWT.
 */
export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStudentMutationLimiter.check(req)) return rateLimited();

  try {
    await connectDB();

    const body = await req.json();
    const { studentId, confirmEmail } = (body ?? {}) as Record<string, unknown>;

    if (!studentId || typeof studentId !== "string") {
      return NextResponse.json(
        { success: false, message: "Student ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Student ID format." },
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

    if (!isDeleteConfirmationValid(confirmEmail, student.email)) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Confirmation does not match the student's email. Type the student's email exactly to permanently delete the account.",
        },
        { status: 400 }
      );
    }

    // Hard delete: remove exactly this document.
    await Student.findByIdAndDelete(studentId);

    return NextResponse.json({
      success: true,
      message: "Student permanently deleted.",
    });
  } catch (error) {
    console.error("Admin student delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete student." },
      { status: 500 }
    );
  }
}
