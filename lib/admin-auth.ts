/**
 * Server-side admin authentication helpers.
 *
 * Used by admin API route handlers to verify:
 * 1. A valid JWT is present
 * 2. The token belongs to an admin (not a student)
 * 3. The admin account is active
 * 4. The token was not issued before a Super Admin password reset
 *
 * Exports:
 * - authenticateAdmin() — any active admin
 * - requireSuperAdmin() — active admin whose DATABASE role is "super_admin"
 *
 * Never trust client-sent roles — always verify from the JWT + database. The
 * JWT only proves identity; the role used for authorization is always read
 * from the Admin document, so a stale/forged role claim cannot escalate.
 */

import { NextResponse } from "next/server";
import { verifyToken, type TokenPayload } from "@/lib/auth-helpers";
import connectDB from "@/lib/mongodb";
import Admin from "@/models/Admin";

export interface AdminAuthResult {
  adminId: string;
  role: string;
}

export interface SuperAdminAuthResult extends AdminAuthResult {
  role: "super_admin";
}

/**
 * Headers for responses that carry credentials (recovered or generated
 * passwords). Credential responses must never be cached by a browser, proxy or
 * CDN.
 */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
} as const;

/**
 * True when the token predates the given password change, meaning it was
 * issued with a password that no longer exists.
 *
 * `iat` has one-second granularity, so a one-second grace window is subtracted:
 * a token minted in the same second as the reset is indistinguishable from a
 * fresh one (an admin who logs in immediately after a reset must not be locked
 * out). Any older token is rejected.
 */
function tokenIssuedBefore(decoded: TokenPayload, changedAt: Date): boolean {
  if (typeof decoded.iat !== "number") return false;
  return decoded.iat * 1000 + 1000 < changedAt.getTime();
}

/**
 * Authenticate and authorize an admin request.
 *
 * Returns { adminId, role } on success, or a NextResponse error on failure.
 * Callers should check: if ("error" in auth) return auth.error;
 */
export async function authenticateAdmin(
  req: Request
): Promise<{ admin: AdminAuthResult } | { error: NextResponse }> {
  const authHeader = req.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      error: NextResponse.json(
        { success: false, message: "Access denied. No token provided." },
        { status: 401 }
      ),
    };
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return {
      error: NextResponse.json(
        { success: false, message: "Access denied. No token provided." },
        { status: 401 }
      ),
    };
  }

  let decoded: TokenPayload;
  try {
    decoded = verifyToken(token);
  } catch (error: unknown) {
    const err = error as { name?: string };
    if (err.name === "TokenExpiredError") {
      return {
        error: NextResponse.json(
          { success: false, message: "Token has expired. Please log in again." },
          { status: 401 }
        ),
      };
    }
    return {
      error: NextResponse.json(
        { success: false, message: "Invalid token." },
        { status: 401 }
      ),
    };
  }

  // Verify the token role is admin-level (not student)
  if (decoded.role === "student") {
    return {
      error: NextResponse.json(
        {
          success: false,
          message: "Access denied. Admin privileges required.",
        },
        { status: 403 }
      ),
    };
  }

  // Verify the admin still exists and is active in the database
  try {
    await connectDB();
    const admin = await Admin.findById(decoded.sub);

    if (!admin) {
      return {
        error: NextResponse.json(
          { success: false, message: "Admin account not found." },
          { status: 401 }
        ),
      };
    }

    if (admin.status !== "active") {
      return {
        error: NextResponse.json(
          {
            success: false,
            message: "Account is inactive. Please contact the administrator.",
          },
          { status: 403 }
        ),
      };
    }

    // A Super Admin password reset invalidates every session opened with the
    // previous password (the resolved field is absent on legacy documents).
    const passwordChangedAt = admin.passwordChangedAt as Date | null | undefined;
    if (passwordChangedAt && tokenIssuedBefore(decoded, passwordChangedAt)) {
      return {
        error: NextResponse.json(
          {
            success: false,
            message: "Session expired. Please log in again.",
          },
          { status: 401 }
        ),
      };
    }

    return {
      admin: { adminId: admin._id.toString(), role: admin.role },
    };
  } catch (error) {
    console.error("Admin auth verification error:", error);
    return {
      error: NextResponse.json(
        { success: false, message: "Authentication failed." },
        { status: 500 }
      ),
    };
  }
}

/**
 * Authenticate the current admin AND require the Super Admin role.
 *
 * Server-side authorization guard for Super Admin-only endpoints — hiding UI
 * elements is never sufficient. Normal admins receive 403.
 *
 * Usage: const auth = await requireSuperAdmin(req);
 *        if ("error" in auth) return auth.error;
 */
export async function requireSuperAdmin(
  req: Request
): Promise<{ admin: SuperAdminAuthResult } | { error: NextResponse }> {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth;

  if (auth.admin.role !== "super_admin") {
    return {
      error: NextResponse.json(
        {
          success: false,
          message: "Access denied. Super Admin privileges required.",
        },
        { status: 403 }
      ),
    };
  }

  return { admin: { adminId: auth.admin.adminId, role: "super_admin" } };
}
