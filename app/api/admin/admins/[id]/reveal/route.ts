import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Admin from "@/models/Admin";
import { NO_STORE_HEADERS, requireSuperAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { recordAdminActivity } from "@/lib/activity-log";
import {
  ADMIN_PASSWORD_SCHEME_AES,
  PasswordConfigError,
  PasswordDecryptionError,
  decryptAdminPassword,
  resolveAdminPasswordScheme,
} from "@/lib/password";

/**
 * POST /api/admin/admins/[id]/reveal
 *
 * Recover the stored password of a NORMAL admin. Super Admin only.
 *
 * This is the ONLY endpoint that returns a credential, and it exists because
 * normal admin passwords are intentionally recoverable (AES-256-GCM). Even so:
 *
 * - Server-side Super Admin authorization is required (never just hidden UI).
 * - The request must explicitly ask for the reveal (`{ confirm: true }`), and
 *   the password is fetched only for the single requested account.
 * - Passwords are never part of the list endpoint, page data, or a URL/query
 *   parameter, and are never logged.
 * - The response is `no-store` so no browser, proxy or CDN can cache it.
 * - A `super_admin` target returns 403: bcrypt hashes are one-way and must not
 *   be recoverable — the same applies to any legacy bcrypt record, which is
 *   reported as not recoverable instead of being attacked.
 */

const adminPasswordRevealLimiter = createRateLimiter({
  name: "admin-password-reveal",
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminPasswordRevealLimiter.check(req)) {
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
    // Explicit acknowledgement — a bare GET/POST cannot silently extract a
    // credential.
    if ((body as Record<string, unknown>).confirm !== true) {
      return NextResponse.json(
        {
          success: false,
          message: "Password recovery must be explicitly confirmed.",
        },
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
          message: "Super Admin passwords are hashed and cannot be recovered.",
        },
        { status: 403 }
      );
    }

    if (resolveAdminPasswordScheme(admin) !== ADMIN_PASSWORD_SCHEME_AES) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This account still uses a legacy bcrypt hash and cannot be recovered. Reset its password to enable recovery.",
        },
        { status: 409 }
      );
    }

    const password = decryptAdminPassword(admin.password);

    // Audited as an event (who recovered whose credential) — never its value.
    await recordAdminActivity({
      action: "admin.password.viewed",
      actorAdminId: auth.admin.adminId,
      targetAdminId: admin._id.toString(),
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          id: admin._id.toString(),
          name: admin.name,
          email: admin.email,
          password,
        },
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof PasswordConfigError) {
      console.error("Password reveal failed: encryption key is missing or invalid.");
      return NextResponse.json(
        { success: false, message: "Password decryption is not configured on the server." },
        { status: 500 }
      );
    }

    if (error instanceof PasswordDecryptionError) {
      // Tampered/undecryptable ciphertext — never echo crypto details.
      console.error("Password reveal failed: stored credential could not be authenticated.");
      return NextResponse.json(
        { success: false, message: "Unable to recover this password. Reset it instead." },
        { status: 500 }
      );
    }

    console.error("Password reveal error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to recover password." },
      { status: 500 }
    );
  }
}
