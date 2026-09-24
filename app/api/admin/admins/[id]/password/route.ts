import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Admin, { toAdminSummary } from "@/models/Admin";
import { NO_STORE_HEADERS, requireSuperAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { recordAdminActivity } from "@/lib/activity-log";
import {
  PasswordConfigError,
  encryptAdminPassword,
  generateAdminPassword,
  validateAdminPassword,
} from "@/lib/password";

/**
 * POST /api/admin/admins/[id]/password
 *
 * Reset a NORMAL admin's password. Super Admin only.
 *
 * Flow: authorize → validate the new password → encrypt with AES-256-GCM →
 * save → stamp `passwordChangedAt` so every JWT issued before the reset stops
 * working. The plaintext is returned ONLY when the server generated it (the UI
 * must display it once); a password typed by the Super Admin is never echoed
 * back.
 *
 * Body: { password?: string } — omit to have a cryptographically secure
 * password generated with crypto.randomBytes (never Math.random).
 *
 * A bcrypt-protected account (i.e. a Super Admin) can never be reset here.
 */

const adminPasswordResetLimiter = createRateLimiter({
  name: "admin-password-reset",
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminPasswordResetLimiter.check(req)) {
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

    const body = await req.json().catch(() => ({}));
    const password = (body as Record<string, unknown>).password;

    const isGenerated =
      password === undefined || password === null || password === "";

    if (!isGenerated) {
      const passwordError = validateAdminPassword(password);
      if (passwordError) {
        return NextResponse.json(
          { success: false, message: passwordError },
          { status: 400 }
        );
      }
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
          message: "Super Admin passwords cannot be reset from the portal.",
        },
        { status: 403 }
      );
    }

    const plaintextPassword = isGenerated
      ? generateAdminPassword()
      : (password as string);

    admin.password = encryptAdminPassword(plaintextPassword);
    admin.passwordScheme = "aes-256-gcm";
    admin.passwordChangedAt = new Date();

    await admin.save();

    // Event only: actor + target + action. Never the password it was set to.
    await recordAdminActivity({
      action: "admin.password.reset",
      actorAdminId: auth.admin.adminId,
      targetAdminId: admin._id.toString(),
    });

    return NextResponse.json(
      {
        success: true,
        message: "Admin password reset successfully.",
        admin: {
          ...toAdminSummary(admin),
          isSelf: admin._id.toString() === auth.admin.adminId,
        },
        generatedPassword: isGenerated ? plaintextPassword : undefined,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof PasswordConfigError) {
      console.error("Admin password reset failed: encryption key is missing or invalid.");
      return NextResponse.json(
        { success: false, message: "Password encryption is not configured on the server." },
        { status: 500 }
      );
    }

    console.error("Admin password reset error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to reset admin password." },
      { status: 500 }
    );
  }
}
