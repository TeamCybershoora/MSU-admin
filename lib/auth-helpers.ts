import { createHmac } from "crypto";
import jwt from "jsonwebtoken";

/**
 * Domain-separation label used to derive the admin key from the legacy secret.
 * It must stay a constant of this application: it is what guarantees the
 * derived admin key is never equal to the student key derived by the public
 * app.
 */
const ADMIN_KEY_DERIVATION_LABEL = "msu-admin-jwt/key-separation/v1";

/**
 * ── Token trust boundary (admin side) ───────────────────────────────────
 *
 * This key signs and verifies ADMIN tokens ONLY. The public student app
 * (D:\msu) signs and verifies its tokens with a DIFFERENT key of its own, so:
 *   - a student-issued token fails signature verification here, and
 *   - an admin token fails signature verification in the public app.
 * The separation is cryptographic — it does not rely on the `role` claim or
 * any post-verification check.
 *
 * Key selection, in order:
 *   1. `ADMIN_JWT_SECRET` — the explicit, independent admin secret. Set this in
 *      every deployment (and make sure it differs from the student secret).
 *   2. Otherwise, a key DERIVED from the legacy `JWT_SECRET` via HMAC-SHA256
 *      with the constant label above, so a single leftover variable can never
 *      collapse the two trust boundaries into one signing key.
 *
 * Only variable NAMES are referenced here — values are never logged, returned
 * or embedded in a token payload.
 */
function getAdminJwtSecret(): string {
  const explicit = process.env.ADMIN_JWT_SECRET;

  if (explicit) {
    if (explicit.length < 32) {
      throw new Error(
        `ADMIN_JWT_SECRET must be at least 32 characters long ` +
          `(received: ${explicit.length} characters).`
      );
    }
    return explicit;
  }

  const legacy = process.env.JWT_SECRET;
  if (!legacy) {
    throw new Error(
      "ADMIN_JWT_SECRET is not defined in the environment (and no legacy " +
        "JWT_SECRET is available to derive the separate admin key from). " +
        "Add ADMIN_JWT_SECRET to your .env.local file at the project root."
    );
  }
  if (legacy.length < 32) {
    throw new Error(
      `The legacy JWT_SECRET must be at least 32 characters long to derive ` +
        `the admin key (received: ${legacy.length} characters).`
    );
  }

  return createHmac("sha256", legacy)
    .update(ADMIN_KEY_DERIVATION_LABEL)
    .digest("hex");
}

/* ── JWT ─────────────────────────────────────────────────────── */

export interface TokenPayload {
  sub: string;
  role: string;
  /** Issued-at (seconds), added by jsonwebtoken. Used to invalidate sessions. */
  iat?: number;
}

export type AdminRole = "admin" | "super_admin";

const secret = getAdminJwtSecret();

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
