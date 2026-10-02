import jwt from "jsonwebtoken";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not defined in the environment. " +
        "Add it to your .env.local file at the project root."
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET must be at least 32 characters long ` +
        `(received: ${secret.length} characters).`
    );
  }
  return secret;
}

/* ── JWT ─────────────────────────────────────────────────────── */

export interface TokenPayload {
  sub: string;
  role: string;
  /** Issued-at (seconds), added by jsonwebtoken. Used to invalidate sessions. */
  iat?: number;
}

export type AdminRole = "admin" | "super_admin";

const secret = getJwtSecret();

/**
 * Generate a JWT for the given admin ID with admin role.
 */
export function generateAdminToken(
  adminId: string,
  adminRole: AdminRole = "admin"
): string {
  return jwt.sign(
    { sub: adminId, role: adminRole } satisfies TokenPayload,
    secret,
    { expiresIn: "2h", algorithm: "HS256" }
  );
}

/**
 * Verify a JWT and return the decoded payload.
 * Throws on invalid/expired tokens — callers should catch and return 401.
 */
export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, secret, {
    algorithms: ["HS256"],
  });
  return decoded as unknown as TokenPayload;
}

/* ── Password ────────────────────────────────────────────────── */

/**
 * Password/bcrypt logic lives in one place: @/lib/password.
 * These aliases exist for callers that predate that module — do not add
 * crypto code here.
 */
export {
  hashSuperAdminPassword as hashPassword,
  verifySuperAdminPassword as comparePassword,
} from "@/lib/password";
