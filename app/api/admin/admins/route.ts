import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Admin, { toAdminSummary, type AdminSummarySource } from "@/models/Admin";
import { NO_STORE_HEADERS, requireSuperAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { isValidEmail } from "@/lib/validation";
import {
  PasswordConfigError,
  encryptAdminPassword,
  generateAdminPassword,
  validateAdminPassword,
} from "@/lib/password";

/**
 * /api/admin/admins — Super Admin account management.
 *
 * GET  — list admin accounts (name, email, role, status, scheme, timestamps).
 *        Passwords are NEVER included in this response.
 * POST — create a NORMAL admin. The password is encrypted with AES-256-GCM so a
 *        Super Admin can recover it later.
 *
 * Both verbs require a server-side super_admin authorization check; normal
 * admins receive 403. Creating a Super Admin is deliberately NOT possible here —
 * it is done with the controlled server-side bootstrap/promote script
 * (scripts/create-super-admin.ts) so a compromised admin session cannot mint a
 * new Super Admin.
 */

const adminAccountsLimiter = createRateLimiter({
  name: "admin-accounts",
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

const MAX_NAME_LENGTH = 100;

export async function GET(req: Request) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminAccountsLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    // +password is selected only so the effective scheme can be reported
    // accurately for legacy records; toAdminSummary() never exposes it.
    const admins = (await Admin.find({})
      .select("+password")
      .sort({ createdAt: 1 })
      .lean()) as unknown as AdminSummarySource[];

    return NextResponse.json(
      {
        success: true,
        data: admins.map((admin) => ({
          ...toAdminSummary(admin),
          isSelf: String(admin._id) === auth.admin.adminId,
        })),
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("Admin list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load admin accounts." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminAccountsLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { name, email, password } = body as Record<string, unknown>;

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json(
        { success: false, message: "Admin name is required." },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();
    if (trimmedName.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { success: false, message: `Admin name must be at most ${MAX_NAME_LENGTH} characters.` },
        { status: 400 }
      );
    }

    if (typeof email !== "string" || !isValidEmail(email.trim())) {
      return NextResponse.json(
        { success: false, message: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const trimmedEmail = email.trim().toLowerCase();

    // A missing password means "generate a strong one"; the Super Admin must
    // then copy it from the response, so it is returned exactly once.
    const isGenerated = password === undefined || password === null || password === "";

    if (!isGenerated) {
      const passwordError = validateAdminPassword(password);
      if (passwordError) {
        return NextResponse.json(
          { success: false, message: passwordError },
          { status: 400 }
        );
      }
    }

    const duplicate = await Admin.findOne({ email: trimmedEmail });
    if (duplicate) {
      return NextResponse.json(
        { success: false, message: "An admin with this email already exists." },
        { status: 409 }
      );
    }

    const plaintextPassword = isGenerated
      ? generateAdminPassword()
      : (password as string);

    const encryptedPassword = encryptAdminPassword(plaintextPassword);

    const admin = await Admin.create({
      name: trimmedName,
      email: trimmedEmail,
      password: encryptedPassword,
      passwordScheme: "aes-256-gcm",
      role: "admin", // Super Admins are created only via the server-side script
      status: "active",
    });

    return NextResponse.json(
      {
        success: true,
        message: "Admin account created successfully.",
        admin: {
          ...toAdminSummary({
            _id: admin._id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
            status: admin.status,
            password: admin.password,
            passwordScheme: admin.passwordScheme,
            lastLogin: admin.lastLogin,
            createdAt: admin.createdAt,
          }),
          isSelf: false,
        },
        // Returned only when the server generated it — the Super Admin must
        // record it now, it is the only time it is shown.
        generatedPassword: isGenerated ? plaintextPassword : undefined,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      code?: number;
      errors?: Record<string, { message: string }>;
    };

    if (err.code === 11000) {
      return NextResponse.json(
        { success: false, message: "An admin with this email already exists." },
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

    if (error instanceof PasswordConfigError) {
      console.error("Admin create failed: encryption key is missing or invalid.");
      return NextResponse.json(
        { success: false, message: "Password encryption is not configured on the server." },
        { status: 500 }
      );
    }

    console.error("Admin create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create admin account." },
      { status: 500 }
    );
  }
}
