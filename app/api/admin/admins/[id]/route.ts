import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Admin, { toAdminSummary } from "@/models/Admin";
import { NO_STORE_HEADERS, requireSuperAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";

/**
 * PATCH /api/admin/admins/[id]
 *
 * Activate or deactivate an admin account. Super Admin only.
 *
 * Scope: only NORMAL admin accounts can be toggled. Targeting a Super Admin
 * (including the caller's own account) is rejected with 403, so a Super Admin
 * can never deactivate a peer or lock itself out.
 *
 * Body: { status: "active" | "inactive" }
 */

const adminStatusLimiter = createRateLimiter({
  name: "admin-status",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

const VALID_STATUSES = ["active", "inactive"] as const;
type AdminStatus = (typeof VALID_STATUSES)[number];

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStatusLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const { id } = await ctx.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, message: "Invalid admin ID format." },
        { status: 400 }
      );
    }

    const body = await req.json();
    const status = (body as Record<string, unknown>).status;

    if (
      typeof status !== "string" ||
      !VALID_STATUSES.includes(status as AdminStatus)
    ) {
      return NextResponse.json(
        { success: false, message: "Status must be either \"active\" or \"inactive\"." },
        { status: 400 }
      );
    }

    await connectDB();

    const admin = await Admin.findById(id).select("+password");
    if (!admin) {
      return NextResponse.json(
        { success: false, message: "Admin account not found." },
        { status: 404 }
      );
    }

    if (admin.role === "super_admin") {
      return NextResponse.json(
        {
          success: false,
          message: "Super Admin accounts cannot be activated or deactivated here.",
        },
        { status: 403 }
      );
    }

    admin.status = status as AdminStatus;
    await admin.save();

    return NextResponse.json(
      {
        success: true,
        message:
          status === "active"
            ? "Admin account activated."
            : "Admin account deactivated.",
        admin: {
          ...toAdminSummary(admin),
          isSelf: admin._id.toString() === auth.admin.adminId,
        },
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("Admin status update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update admin account." },
      { status: 500 }
    );
  }
}
