import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import College, { toSafeCollege } from "@/models/College";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { escapeRegex } from "@/lib/validation";

const adminCollegeLimiter = createRateLimiter({
  name: "admin-colleges",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminCollegeLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const search = url.searchParams.get("search")?.trim() || "";
    const district = url.searchParams.get("district")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};
    if (search) {
      query.$or = [
        { collegeName: { $regex: escapeRegex(search), $options: "i" } },
        { collegeCode: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }
    if (district) {
      query.district = district;
    }

    const districts = await College.distinct("district", district ? { district } : {});

    const [colleges, total] = await Promise.all([
      College.find(query)
        .sort({ collegeName: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      College.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: colleges.map((c) => ({
        id: c._id,
        collegeName: c.collegeName,
        collegeCode: c.collegeCode || "",
        district: c.district || "",
        createdAt: c.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        districts: [...new Set([...districts, "Saharanpur", "Shamli", "Muzaffarnagar"])].sort(),
      },
    });
  } catch (error) {
    console.error("Admin colleges list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load colleges." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { collegeName, collegeCode, district } = body;

    if (!collegeName || typeof collegeName !== "string" || !collegeName.trim()) {
      return NextResponse.json(
        { success: false, message: "College name is required." },
        { status: 400 }
      );
    }

    const validDistricts = ["Saharanpur", "Shamli", "Muzaffarnagar", ""];
    const districtValue = validDistricts.includes(district) ? district : "";

    const existing = await College.findOne({
      collegeName: collegeName.trim(),
    }).collation({ locale: "en", strength: 2 });

    if (existing) {
      return NextResponse.json(
        { success: false, message: "A college with this name already exists." },
        { status: 409 }
      );
    }

    const college = await College.create({
      collegeName: collegeName.trim(),
      collegeCode: collegeCode ? collegeCode.trim() : "",
      district: districtValue,
    });

    return NextResponse.json({
      success: true,
      message: "College created successfully.",
      college: toSafeCollege(college),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      code?: number;
      errors?: Record<string, { message: string }>;
    };

    if (err.code === 11000) {
      return NextResponse.json(
        { success: false, message: "A college with this name already exists." },
        { status: 409 }
      );
    }

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin college create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create college." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { collegeId, collegeName, collegeCode, district } = body;

    if (!collegeId || typeof collegeId !== "string") {
      return NextResponse.json(
        { success: false, message: "College ID is required." },
        { status: 400 }
      );
    }

    const college = await College.findById(collegeId);
    if (!college) {
      return NextResponse.json(
        { success: false, message: "College not found." },
        { status: 404 }
      );
    }

    if (collegeName !== undefined) {
      if (typeof collegeName !== "string" || !collegeName.trim()) {
        return NextResponse.json(
          { success: false, message: "College name cannot be empty." },
          { status: 400 }
        );
      }

      const duplicate = await College.findOne({
        collegeName: collegeName.trim(),
        _id: { $ne: collegeId },
      }).collation({ locale: "en", strength: 2 });

      if (duplicate) {
        return NextResponse.json(
          { success: false, message: "A college with this name already exists." },
          { status: 409 }
        );
      }

      college.collegeName = collegeName.trim();
    }

    if (collegeCode !== undefined) {
      college.collegeCode = typeof collegeCode === "string" ? collegeCode.trim() : "";
    }

    if (district !== undefined) {
      const validDistricts = ["Saharanpur", "Shamli", "Muzaffarnagar", ""];
      college.district = validDistricts.includes(district) ? district : college.district;
    }

    await college.save();

    return NextResponse.json({
      success: true,
      message: "College updated successfully.",
      college: toSafeCollege(college),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      code?: number;
      errors?: Record<string, { message: string }>;
    };

    if (err.code === 11000) {
      return NextResponse.json(
        { success: false, message: "A college with this name already exists." },
        { status: 409 }
      );
    }

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin college update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update college." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { collegeId } = body;

    if (!collegeId || typeof collegeId !== "string") {
      return NextResponse.json(
        { success: false, message: "College ID is required." },
        { status: 400 }
      );
    }

    const college = await College.findByIdAndDelete(collegeId);
    if (!college) {
      return NextResponse.json(
        { success: false, message: "College not found." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "College deleted successfully.",
    });
  } catch (error) {
    console.error("Admin college delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete college." },
      { status: 500 }
    );
  }
}
