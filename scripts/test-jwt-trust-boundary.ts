/**
 * Offline verification of the JWT trust boundary between this admin app and the
 * public student app (P2: they must not share signing material).
 *
 * Runs entirely in memory — no MongoDB connection, no HTTP, and no .env value
 * is read, printed or logged:
 *
 *   student-signature token → public/student verifier : PASS
 *   admin-signature token   → admin verifier          : PASS
 *   admin-signature token   → public/student verifier : REJECTED
 *   student-signature token → admin verifier          : REJECTED
 *   expired tokens (both sides)                       : REJECTED
 *   tampered tokens (both sides)                      : REJECTED
 *
 * The critical property is CRYPTOGRAPHIC, not authorization-based: rejection
 * happens during signature verification, before any `role` check. That is
 * asserted explicitly — an admin-key token claiming `role: "student"`, and a
 * student-key token claiming `role: "super_admin"`, are both refused as invalid
 * SIGNATURES rather than as role/authorization failures.
 *
 * Usage: npx tsx scripts/test-jwt-trust-boundary.ts
 */
import { createHmac } from "crypto";
import jwt from "jsonwebtoken";

/*
 * @/lib/auth-helpers validates the secret at module load. A throwaway dummy is
 * used ONLY when the process has none (no .env file is read and no secret value
 * is ever printed); a real value already in the environment is used as-is.
 */
process.env.JWT_SECRET ??=
  "offline-jwt-boundary-test-secret-0123456789abcdef";

/**
 * Must match ADMIN_KEY_DERIVATION_LABEL in lib/auth-helpers.ts — it is what
 * keeps the derived admin key distinct from the public student key.
 */
const ADMIN_KEY_DERIVATION_LABEL = "msu-admin-jwt/key-separation/v1";

/* ── Tiny assertion harness (same shape as the other offline scripts) ────── */

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

/** Run `fn` and report whether it rejected, plus the thrown error's name. */
function rejection(fn: () => unknown): { rejected: boolean; name: string } {
  try {
    fn();
    return { rejected: false, name: "" };
  } catch (error) {
    return {
      rejected: true,
      name: (error as { name?: string }).name ?? "Error",
    };
  }
}

/** Corrupt the signature segment of a JWT. */
function tamperSignature(token: string): string {
  const parts = token.split(".");
  const original = parts[2];
  parts[2] = (original[0] === "a" ? "b" : "a") + original.slice(1);
  return parts.join(".");
}

/**
 * The realistic payload attack: rewrite the claim set (e.g. escalate `role`)
 * and keep the original signature. The re-encoded payload stays valid JSON, so
 * the token can only fail at the SIGNATURE comparison — exactly the property
 * under test.
 */
function tamperPayload(token: string, patch: Record<string, unknown>): string {
  const parts = token.split(".");
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8")
  ) as Record<string, unknown>;
  parts[1] = Buffer.from(
    JSON.stringify({ ...payload, ...patch })
  ).toString("base64url");
  return parts.join(".");
}

async function main() {
  const { generateAdminToken, verifyToken } = await import(
    "@/lib/auth-helpers"
  );

  /*
   * Effective keys, selected exactly as each application selects them:
   *   public/student app → STUDENT_JWT_SECRET, else the legacy JWT_SECRET
   *   this admin app     → ADMIN_JWT_SECRET, else HMAC(legacy JWT_SECRET, label)
   */
  const studentKey =
    process.env.STUDENT_JWT_SECRET ?? (process.env.JWT_SECRET as string);
  const adminKey =
    process.env.ADMIN_JWT_SECRET ??
    createHmac("sha256", process.env.JWT_SECRET as string)
      .update(ADMIN_KEY_DERIVATION_LABEL)
      .digest("hex");

  const studentId = "0123456789abcdef01234567";
  const studentPayload = { sub: studentId, role: "student" };

  // `jwt.SignOptions["expiresIn"]` keeps jsonwebtoken's own literal type
  // (`number | "1h" | "-1s" | …`) instead of accepting any string.
  const signStudent = (
    payload: object,
    expiresIn: jwt.SignOptions["expiresIn"]
  ) => jwt.sign(payload, studentKey, { expiresIn, algorithm: "HS256" });
  const signAdminKeyed = (
    payload: object,
    expiresIn: jwt.SignOptions["expiresIn"]
  ) => jwt.sign(payload, adminKey, { expiresIn, algorithm: "HS256" });
  const verifyAsStudent = (token: string) =>
    jwt.verify(token, studentKey, { algorithms: ["HS256"] });
  const verifyAsAdmin = (token: string) => verifyToken(token);

  /* ── 1. Two distinct keys ────────────────────────────────────────────── */

  section("1. The two trust boundaries use different keys");
  check("admin key !== student key", adminKey !== studentKey);
  check(
    "the admin key is never the legacy student secret",
    adminKey !== process.env.JWT_SECRET
  );
  check("the admin key is at least 32 characters", adminKey.length >= 32);

  /* ── 2. Each side accepts its own tokens (Tests A / B) ───────────────── */

  section("2. Own tokens still verify (Test A / Test B)");
  const studentToken = signStudent(studentPayload, "1h");
  check(
    "a student-signed token verifies under the student key",
    rejection(() => verifyAsStudent(studentToken)).rejected === false
  );
  const adminToken = generateAdminToken(studentId, "admin");
  const adminOwn = rejection(() => verifyAsAdmin(adminToken));
  check(
    "an admin-signed token verifies under the admin key",
    adminOwn.rejected === false,
    adminOwn.name
  );
  check(
    "the admin payload contract is unchanged (sub + role)",
    typeof (verifyAsAdmin(adminToken) as { sub?: string }).sub === "string" &&
      (verifyAsAdmin(adminToken) as { role?: string }).role === "admin"
  );

  /* ── 3. Cross-trust rejection (Tests C / D) ──────────────────────────── */

  section("3. Cross-trust tokens are rejected (Test C / Test D)");
  const adminToStudent = rejection(() => verifyAsStudent(adminToken));
  check("ADMIN token → public student verifier: REJECTED", adminToStudent.rejected);
  check(
    "...rejected as a signature failure (JsonWebTokenError)",
    adminToStudent.name === "JsonWebTokenError",
    adminToStudent.name
  );

  const studentToAdmin = rejection(() => verifyAsAdmin(studentToken));
  check("STUDENT token → admin verifier: REJECTED", studentToAdmin.rejected);
  check(
    "...rejected as a signature failure, not an authorization failure",
    studentToAdmin.name === "JsonWebTokenError",
    studentToAdmin.name
  );

  /* ── 4. Rejection is cryptographic, never a role/claims decision ─────── */

  section("4. Rejection is cryptographic (not a `role` check)");
  const adminKeyedStudentRole = signAdminKeyed(studentPayload, "1h");
  const roleClaimStudent = rejection(() =>
    verifyAsStudent(adminKeyedStudentRole)
  );
  check(
    "an ADMIN-key token claiming role=student is still rejected by the student verifier",
    roleClaimStudent.rejected && roleClaimStudent.name === "JsonWebTokenError",
    roleClaimStudent.name
  );

  const studentKeyedSuperAdmin = signStudent(
    { sub: studentId, role: "super_admin" },
    "1h"
  );
  const roleClaimSuper = rejection(() => verifyAsAdmin(studentKeyedSuperAdmin));
  check(
    "a STUDENT-key token claiming role=super_admin is rejected by SIGNATURE, not 403",
    roleClaimSuper.rejected && roleClaimSuper.name === "JsonWebTokenError",
    roleClaimSuper.name
  );

  /* ── 5. Expiry handling is preserved (Test E) ────────────────────────── */

  section("5. Expired tokens remain rejected (Test E)");
  const expiredStudent = signStudent(studentPayload, "-1s");
  const expiredStudentResult = rejection(() => verifyAsStudent(expiredStudent));
  check(
    "an expired student token is rejected as expired",
    expiredStudentResult.rejected &&
      expiredStudentResult.name === "TokenExpiredError",
    expiredStudentResult.name
  );

  const expiredAdmin = signAdminKeyed(
    { sub: studentId, role: "admin" },
    "-1s"
  );
  const expiredAdminResult = rejection(() => verifyAsAdmin(expiredAdmin));
  check(
    "an expired admin-key token is rejected by the admin verifier as expired",
    expiredAdminResult.rejected &&
      expiredAdminResult.name === "TokenExpiredError",
    expiredAdminResult.name
  );

  /* ── 6. Tampering remains rejected (Test F) ──────────────────────────── */

  section("6. Tampered tokens remain rejected (Test F)");
  const tamperedStudentPayload = rejection(() =>
    verifyAsStudent(tamperPayload(studentToken, { role: "admin" }))
  );
  check(
    "a student token whose claims were rewritten is rejected",
    tamperedStudentPayload.rejected &&
      tamperedStudentPayload.name === "JsonWebTokenError",
    tamperedStudentPayload.name
  );
  const tamperedStudentSig = rejection(() =>
    verifyAsStudent(tamperSignature(studentToken))
  );
  check(
    "a student token with a modified signature is rejected",
    tamperedStudentSig.rejected && tamperedStudentSig.name === "JsonWebTokenError",
    tamperedStudentSig.name
  );
  const tamperedAdminSig = rejection(() =>
    verifyAsAdmin(tamperSignature(adminToken))
  );
  check(
    "an admin token with a modified signature is rejected",
    tamperedAdminSig.rejected && tamperedAdminSig.name === "JsonWebTokenError",
    tamperedAdminSig.name
  );
  const tamperedAdminPayload = rejection(() =>
    verifyAsAdmin(tamperPayload(adminToken, { role: "super_admin" }))
  );
  check(
    "an admin token whose claims were escalated is rejected",
    tamperedAdminPayload.rejected &&
      tamperedAdminPayload.name === "JsonWebTokenError",
    tamperedAdminPayload.name
  );

  /* ── 7. Token contracts unchanged ────────────────────────────────────── */

  section("7. Token contracts preserved (no claim/expiry changes)");
  const studentDecoded = verifyAsStudent(studentToken) as jwt.JwtPayload;
  const adminDecoded = verifyAsAdmin(adminToken) as jwt.JwtPayload;

  check(
    "student token lifetime is still 1 hour",
    studentDecoded.exp! - studentDecoded.iat! === 3600
  );
  check(
    "admin token lifetime is still 2 hours",
    adminDecoded.exp! - adminDecoded.iat! === 7200
  );
  check(
    "both tokens are still HS256",
    jwt.decode(studentToken, { complete: true })?.header.alg === "HS256" &&
      jwt.decode(adminToken, { complete: true })?.header.alg === "HS256"
  );
  check(
    "the student payload is still exactly sub/role/iat/exp",
    Object.keys(studentDecoded).sort().join(",") === "exp,iat,role,sub"
  );
  check(
    "no issuer/audience claim was introduced",
    studentDecoded.iss === undefined && studentDecoded.aud === undefined
  );

  /* ── Summary ─────────────────────────────────────────────────────────── */

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(
    failed === 0
      ? "JWT trust boundary verified: student→student PASS, admin→admin PASS, admin→student REJECTED, student→admin REJECTED."
      : "JWT trust boundary verification FAILED."
  );
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(
    "Test run failed:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
