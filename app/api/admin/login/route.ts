import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Admin, { toSafeAdmin } from "@/models/Admin";
import { generateAdminToken } from "@/lib/auth-helpers";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  PasswordConfigError,
  migrateLegacyAdminPassword,
  verifyAdminPassword,
} from "@/lib/password";

/**
 * POST /api/admin/login
 *
 * Admin authentication endpoint supporting both password storage schemes:
 *
 * - "aes-256-gcm" (normal admins) — the stored ciphertext is decrypted with the
 *   server key and compared in constant time.
 * - "bcrypt" (super admins, plus any legacy record without a scheme) — one-way
 *   hash comparison.
 *
 * Legacy migration:
 *   A normal admin whose record still holds a bcrypt hash is upgraded to
 *   AES-256-GCM right after a SUCCESSFUL login, by re-encrypting the plaintext
 *   the admin just submitted. A bcrypt hash is never reversed, and the account
 *   keeps its _id, email, name, role, status and timestamps.
 *
 * Returns a JWT token and safe admin data on success.
 */

const adminLoginLimiter = createRateLimiter({
  name: "admin-login",
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

export async function POST(req: Request) {
  // Rate limit check
  if (adminLoginLimiter.check(req)) {
    return NextResponse.json(
      {
        success: false,
        message: "Too many authentication attempts. Please try again later.",
      },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const { email, password } = await req.json();

    // Validate required fields
    if (!email || typeof email !== "string" || !email.trim()) {
      return NextResponse.json(
        { success: false, message: "Email is required." },
        { status: 400 }
      );
    }

    if (!password || typeof password !== "string") {
      return NextResponse.json(
        { success: false, message: "Password is required." },
        { status: 400 }
      );
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Find admin (include password field)
    const admin = await Admin.findOne({ email: trimmedEmail }).select(
      "+password"
    );

    // Generic error message to prevent account enumeration
    const GENERIC_ERROR = "Invalid email or password.";

    if (!admin) {
      return NextResponse.json(
        { success: false, message: GENERIC_ERROR },
        { status: 401 }
      );
    }

    // Check if admin is active
    if (admin.status !== "active") {
      return NextResponse.json(
        {
          success: false,
          message: "Account is inactive. Please contact the administrator.",
        },
        { status: 403 }
      );
    }

    // Verify against the scheme that actually protects this record.
    // Missing passwordScheme is treated as bcrypt (legacy behaviour).
    const verification = await verifyAdminPassword(password, admin);

    if (!verification.ok) {
      return NextResponse.json(
        { success: false, message: GENERIC_ERROR },
        { status: 401 }
      );
    }

    // Update last login first, so a migration save persists both changes.
    admin.lastLogin = new Date();

    if (verification.needsMigration) {
      try {
        await migrateLegacyAdminPassword(admin, password);
      } catch (error) {
        // A misconfigured encryption key must not block a legitimate login:
        // the bcrypt comparison above already authenticated this admin.
        // Nothing sensitive is logged here.
        if (error instanceof PasswordConfigError) {
          console.error(
            "Legacy admin password migration skipped: encryption key is missing or invalid."
          );
        } else {
          console.error("Legacy admin password migration failed:", error);
        }
        admin.lastLogin = new Date();
        await admin.save();
      }
    } else {
      await admin.save();
    }

    // Generate JWT token with admin role
    const token = generateAdminToken(admin._id.toString(), admin.role);

    return NextResponse.json({
      success: true,
      message: "Login successful.",
      token,
      admin: toSafeAdmin(admin),
    });
  } catch (error) {
    console.error("Admin login error:", error);
    return NextResponse.json(
      {
        success: false,
        message: "Internal server error. Please try again later.",
      },
      { status: 500 }
    );
  }
}
