import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Result, { toSafeResult, type IResult } from "@/models/Result";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { escapeRegex } from "@/lib/validation";

/**
 * GET /api/admin/results
 *
 * List, search, and filter result records.
 * Query params: search, status, page, limit, resultId
 * Protected: requires admin JWT.
 */

const adminResultLimiter = createRateLimiter({
  name: "admin-results",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const resultId = url.searchParams.get("resultId")?.trim() || "";

    // ── Single-result fetch (for Edit form) ──
    if (resultId) {
      if (!mongoose.Types.ObjectId.isValid(resultId)) {
        return NextResponse.json(
          { success: false, message: "Invalid Result ID format." },
          { status: 400 }
        );
      }

      const result = await Result.findById(resultId).lean() as unknown as IResult | null;
      if (!result) {
        return NextResponse.json(
          { success: false, message: "Result not found." },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        data: {
          id: result._id,
          student: {
            name: result.student.name,
            rollNumber: result.student.rollNumber,
            enrollmentNumber: result.student.enrollmentNumber,
            course: result.student.course,
            semester: result.student.semester,
            academicSession: result.student.academicSession,
            collegeName: result.student.collegeName,
          },
          subjects: result.subjects.map((s) => ({
            subjectCode: s.subjectCode,
            subjectName: s.subjectName,
            internalMarks: s.internalMarks,
            externalMarks: s.externalMarks,
            totalMarks: s.totalMarks,
            maxMarks: s.maxMarks,
            grade: s.grade,
            gradePoint: s.gradePoint,
            credits: s.credits,
            isBacklog: s.isBacklog,
          })),
          totalMarks: result.totalMarks,
          maxTotalMarks: result.maxTotalMarks,
          percentage: result.percentage,
          cgpa: result.cgpa,
          resultStatus: result.resultStatus,
          remarks: result.remarks,
          declaredDate: result.declaredDate,
          createdAt: result.createdAt,
        },
      });
    }

    // ── List/search/filter ──
    const search = url.searchParams.get("search")?.trim() || "";
    const status = url.searchParams.get("status")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (search) {
      query.$or = [
        { "student.name": { $regex: escapeRegex(search), $options: "i" } },
        { "student.rollNumber": { $regex: escapeRegex(search), $options: "i" } },
        { "student.enrollmentNumber": { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    if (status) {
      query.resultStatus = status.toUpperCase();
    }

    const [results, total] = await Promise.all([
      Result.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Result.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: results.map((r) => ({
        id: r._id,
        student: {
          name: r.student.name,
          rollNumber: r.student.rollNumber,
          enrollmentNumber: r.student.enrollmentNumber,
          course: r.student.course,
          semester: r.student.semester,
        },
        totalMarks: r.totalMarks,
        maxTotalMarks: r.maxTotalMarks,
        percentage: r.percentage,
        cgpa: r.cgpa,
        resultStatus: r.resultStatus,
        declaredDate: r.declaredDate,
        createdAt: r.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Admin results list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load results." },
      { status: 500 }
    );
  }
}

/* ── Validation helpers ─────────────────────────────────────────── */

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim();
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

const VALID_STATUSES = ["PASS", "FAIL", "COMPARTMENT"] as const;

function validateSubject(
  sub: unknown,
  index: number
): { ok: true; subject: Record<string, unknown> } | { ok: false; error: string } {
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
    return { ok: false, error: `Subject at index ${index} must be an object.` };
  }

  const s = sub as Record<string, unknown>;

  const subjectCode = trimString(s.subjectCode);
  const subjectName = trimString(s.subjectName);
  const grade = trimString(s.grade);

  if (!subjectCode) return { ok: false, error: `Subject at index ${index}: subjectCode is required.` };
  if (!subjectName) return { ok: false, error: `Subject at index ${index}: subjectName is required.` };
  if (!isNonNegativeNumber(s.internalMarks)) return { ok: false, error: `Subject "${subjectCode}": internalMarks must be a non-negative number.` };
  if (!isNonNegativeNumber(s.externalMarks)) return { ok: false, error: `Subject "${subjectCode}": externalMarks must be a non-negative number.` };
  if (!isNonNegativeNumber(s.totalMarks)) return { ok: false, error: `Subject "${subjectCode}": totalMarks must be a non-negative number.` };
  if (!isPositiveNumber(s.maxMarks)) return { ok: false, error: `Subject "${subjectCode}": maxMarks must be a positive number.` };
  if (!grade) return { ok: false, error: `Subject at index ${index}: grade is required.` };
  if (!isNonNegativeNumber(s.gradePoint)) return { ok: false, error: `Subject "${subjectCode}": gradePoint must be a non-negative number.` };
  if (!isPositiveInteger(s.credits)) return { ok: false, error: `Subject "${subjectCode}": credits must be a positive integer.` };

  return {
    ok: true,
    subject: {
      subjectCode, subjectName,
      internalMarks: s.internalMarks, externalMarks: s.externalMarks,
      totalMarks: s.totalMarks, maxMarks: s.maxMarks,
      grade, gradePoint: s.gradePoint, credits: s.credits,
      isBacklog: s.isBacklog === true,
    },
  };
}

function validateResultBody(
  body: unknown
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }

  const b = body as Record<string, unknown>;

  if (!b.student || typeof b.student !== "object" || Array.isArray(b.student)) {
    return { ok: false, error: "Student information is required." };
  }

  const student = b.student as Record<string, unknown>;
  const studentFields = ["name", "rollNumber", "enrollmentNumber", "course", "semester", "academicSession", "collegeName"] as const;

  const cleanedStudent: Record<string, string> = {};
  for (const field of studentFields) {
    const val = trimString(student[field]);
    if (!val) return { ok: false, error: `Student field "${field}" is required.` };
    cleanedStudent[field] = val;
  }

  if (!Array.isArray(b.subjects) || b.subjects.length === 0) {
    return { ok: false, error: "At least one subject is required." };
  }

  const cleanedSubjects: Record<string, unknown>[] = [];
  for (let i = 0; i < b.subjects.length; i++) {
    const result = validateSubject(b.subjects[i], i);
    if (!result.ok) return result;
    cleanedSubjects.push(result.subject);
  }

  if (!isNonNegativeNumber(b.totalMarks)) return { ok: false, error: "totalMarks must be a non-negative number." };
  if (!isPositiveNumber(b.maxTotalMarks)) return { ok: false, error: "maxTotalMarks must be a positive number." };
  if (!isPercentage(b.percentage)) return { ok: false, error: "percentage must be between 0 and 100." };

  const cgpa = trimString(b.cgpa);
  if (!cgpa) return { ok: false, error: "cgpa is required." };

  const resultStatus = trimString(b.resultStatus)?.toUpperCase();
  if (!resultStatus || !VALID_STATUSES.includes(resultStatus as typeof VALID_STATUSES[number])) {
    return { ok: false, error: `resultStatus must be one of: ${VALID_STATUSES.join(", ")}.` };
  }

  const remarks = trimString(b.remarks) ?? "";
  const declaredDate = trimString(b.declaredDate);
  if (!declaredDate) return { ok: false, error: "declaredDate is required." };

  return {
    ok: true,
    data: {
      student: cleanedStudent, subjects: cleanedSubjects,
      totalMarks: b.totalMarks, maxTotalMarks: b.maxTotalMarks,
      percentage: b.percentage, cgpa, resultStatus, remarks, declaredDate,
    },
  };
}

/* ── POST /api/admin/results ────────────────────────────────────── */

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();

    const validation = validateResultBody(body);
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, message: validation.error },
        { status: 400 }
      );
    }

    const result = await Result.create(validation.data);

    return NextResponse.json({
      success: true,
      message: "Result created successfully.",
      result: toSafeResult(result),
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

    console.error("Admin result create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create result." },
      { status: 500 }
    );
  }
}

/* ── PUT /api/admin/results ─────────────────────────────────────── */

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { resultId } = body as Record<string, unknown>;

    if (!resultId || typeof resultId !== "string") {
      return NextResponse.json(
        { success: false, message: "Result ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(resultId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Result ID format." },
        { status: 400 }
      );
    }

    const result = await Result.findById(resultId);
    if (!result) {
      return NextResponse.json(
        { success: false, message: "Result not found." },
        { status: 404 }
      );
    }

    // Apply updates from the body
    if (body.student && typeof body.student === "object") {
      const student = body.student as Record<string, string>;
      for (const [key, value] of Object.entries(student)) {
        if (typeof value === "string" && value.trim()) {
          (result.student as Record<string, unknown>)[key] = value.trim();
        }
      }
    }

    if (Array.isArray(body.subjects)) {
      const validation = validateResultBody(body);
      if (!validation.ok) {
        return NextResponse.json(
          { success: false, message: validation.error },
          { status: 400 }
        );
      }
      result.subjects = validation.data.subjects as IResult["subjects"];
    }

    if (typeof body.totalMarks === "number") result.totalMarks = body.totalMarks;
    if (typeof body.maxTotalMarks === "number") result.maxTotalMarks = body.maxTotalMarks;
    if (typeof body.percentage === "number") result.percentage = body.percentage;
    if (typeof body.cgpa === "string") result.cgpa = body.cgpa;
    if (typeof body.resultStatus === "string") result.resultStatus = body.resultStatus as "PASS" | "FAIL" | "COMPARTMENT";
    if (typeof body.remarks === "string") result.remarks = body.remarks;
    if (typeof body.declaredDate === "string") result.declaredDate = body.declaredDate;

    await result.save();

    return NextResponse.json({
      success: true,
      message: "Result updated successfully.",
      result: toSafeResult(result as unknown as IResult),
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

    console.error("Admin result update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update result." },
      { status: 500 }
    );
  }
}

/* ── DELETE /api/admin/results ──────────────────────────────────── */

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { resultId } = body as Record<string, unknown>;

    if (!resultId || typeof resultId !== "string") {
      return NextResponse.json(
        { success: false, message: "Result ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(resultId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Result ID format." },
        { status: 400 }
      );
    }

    const result = await Result.findById(resultId);
    if (!result) {
      return NextResponse.json(
        { success: false, message: "Result not found." },
        { status: 404 }
      );
    }

    await Result.findByIdAndDelete(resultId);

    return NextResponse.json({
      success: true,
      message: "Result deleted successfully.",
    });
  } catch (error) {
    console.error("Admin result delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete result." },
      { status: 500 }
    );
  }
}
