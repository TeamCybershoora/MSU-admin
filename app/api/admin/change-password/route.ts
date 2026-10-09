import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Admin, { toSafeAdmin } from "@/models/Admin";
import { NO_STORE_HEADERS, authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { generateAdminToken } from "@/lib/auth-helpers";
import { recordAdminActivity } from "@/lib/activity-log";
import {
  PasswordConfigError,
  encryptAdminPassword,
  validateAdminPassword,
  verifyAdminPassword,
} from "@/lib/password";

/**
 * POST /api/admin/change-password
 *
 * Lets the signed-in NORMAL admin change their own password:
 * current password → new password → confirm new password.
 *
 * Flow:
 *  1. Authenticate the current admin (active account, valid JWT).
 *  2. Verify the submitted current password with the scheme that protects the
 *     record — bcrypt for a legacy account, AES-256-GCM once migrated.
 *  3. Validate the new password with the shared rules.
 *  4. Encrypt it with AES-256-GCM and store it as THE current password
 *     (single source of truth — nothing else keeps a copy), so a Super Admin's
 *     "View Current Password" returns this new value.
 *  5. Stamp `passwordChangedAt` and hand the caller a freshly issued token, so
 *     the change ends every OTHER session while this one stays signed in.
 *
 * A legacy bcrypt normal admin is upgraded to AES-256-GCM by this flow; the
 * existing bcrypt hash is never decrypted or converted.
 *
 * Super Admin accounts are deliberately out of scope: their passwords are
 * bcrypt-hashed and must never be reversible, so this endpoint refuses them
 * (403). Super Admin credentials are managed by scripts/create-super-admin.ts.
 *
 * Body: { currentPassword, newPassword, confirmNewPassword }
 * Never returns a password.
 */

const changePasswordLimiter = createRateLimiter({
  name: "admin-change-password",
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (changePasswordLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { currentPassword, newPassword, confirmNewPassword } = body as Record<
      string,
      unknown
    >;

    if (typeof currentPassword !== "string" || currentPassword.length === 0) {
      return NextResponse.json(
        { success: false, message: "Current password is required." },
        { status: 400 }
      );
    }

    const newPasswordError = validateAdminPassword(newPassword);
    if (newPasswordError) {
      return NextResponse.json(
        { success: false, message: newPasswordError },
        { status: 400 }
      );
    }

    if (confirmNewPassword !== newPassword) {
      return NextResponse.json(
        { success: false, message: "New password and confirmation do not match." },
        { status: 400 }
      );
    }

    await connectDB();

    const admin = await Admin.findById(auth.admin.adminId).select("+password");
    if (!admin) {
      return NextResponse.json(
        { success: false, message: "Admin account not found." },
        { status: 401 }
      );
    }

    if (admin.role === "super_admin") {
      return NextResponse.json(
        {
          success: false,
          message:
            "Super Admin passwords are bcrypt-hashed and are managed outside the portal.",
        },
        { status: 403 }
      );
    }

    // Scheme-aware verification: bcrypt for legacy records, AES-256-GCM after.
    const verification = await verifyAdminPassword(currentPassword, admin);
    if (!verification.ok) {
      return NextResponse.json(
        { success: false, message: "Current password is incorrect." },
        { status: 401 }
      );
    }

    // Replace the single stored credential — the previous value is gone.
    admin.password = encryptAdminPassword(newPassword as string);
    admin.passwordScheme = "aes-256-gcm";
    admin.passwordChangedAt = new Date();
    await admin.save();

    // Event only — the event shape has no field that could hold a password.
    await recordAdminActivity({
      action: "admin.password.changed",
      actorAdminId: auth.admin.adminId,
      targetAdminId: admin._id.toString(),
    });

    // Re-issue this session's token; every token issued before the change
    // (including any other open session) is now rejected by authenticateAdmin().
    const token = generateAdminToken(admin._id.toString(), admin.role);

    return NextResponse.json(
      {
        success: true,
        message:
          "Password changed successfully. Other signed-in sessions have been signed out.",
        token,
        admin: toSafeAdmin(admin),
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof PasswordConfigError) {
      console.error(
        "Admin password change failed: encryption key is missing or invalid."
      );
      return NextResponse.json(
        { success: false, message: "Password encryption is not configured on the server." },
        { status: 500 }
      );
    }

    console.error("Admin password change error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to change password." },
      { status: 500 }
    );
  }
}
