/**
 * Server-side admin password helpers — the single source of truth for how an
 * Admin Portal password is stored and verified.
 *
 * Two storage schemes exist, selected by `Admin.passwordScheme`:
 *
 * 1. "aes-256-gcm" — reversible encryption for NORMAL admins.
 *    The plaintext is recoverable by an authorized Super Admin (see the
 *    reveal-password endpoint). The 32-byte key lives ONLY in the
 *    `ADMIN_PASSWORD_ENCRYPTION_KEY` environment variable — never in MongoDB
 *    and never in source code.
 *
 * 2. "bcrypt" — one-way hashing for SUPER admins.
 *    A Super Admin password can never be decrypted or displayed.
 *
 * Migration of legacy records (bcrypt hash, no `passwordScheme`) replaces the
 * stored value with an AES-256-GCM ciphertext *after* a successful bcrypt
 * login. A bcrypt hash is never reversed — the plaintext submitted at login is
 * re-encrypted instead.
 *
 * This module is server-only (Node `crypto` + bcrypt). Never import it from a
 * client component, and never log any of its inputs/outputs.
 */

import crypto from "crypto";
import bcrypt from "bcrypt";

/* ── Public scheme vocabulary ────────────────────────────────── */

export const ADMIN_PASSWORD_SCHEME_AES = "aes-256-gcm" as const;
export const ADMIN_PASSWORD_SCHEME_BCRYPT = "bcrypt" as const;

/** Allowed values of `Admin.passwordScheme`. */
export type AdminPasswordScheme =
  | typeof ADMIN_PASSWORD_SCHEME_AES
  | typeof ADMIN_PASSWORD_SCHEME_BCRYPT;

/** Minimum length accepted for any admin password (matches the model rule). */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

/* ── Constants ───────────────────────────────────────────────── */

const AES_ALGORITHM = "aes-256-gcm";
const CIPHERTEXT_VERSION = "v1";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce — recommended GCM size
const AUTH_TAG_BYTES = 16;
const BCRYPT_SALT_ROUNDS = 10;
const ENCRYPTION_KEY_ENV = "ADMIN_PASSWORD_ENCRYPTION_KEY";

/**
 * Versioned ciphertext format: `v1:<iv>:<authTag>:<ciphertext>`
 * Every part is base64 (Mongo-safe, no delimiters inside the alphabet).
 */
const CIPHERTEXT_PATTERN = /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;

/* ── Errors ──────────────────────────────────────────────────── */

/**
 * Server configuration problem (missing/invalid encryption key).
 * Callers should log this server-side and answer the client with a generic
 * message — never echo these details to a client.
 */
export class PasswordConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordConfigError";
  }
}

/**
 * Stored ciphertext could not be authenticated or decoded (wrong key, tampered
 * data, unknown format). Deliberately carries no crypto detail.
 */
export class PasswordDecryptionError extends Error {
  constructor(message = "Stored admin credential could not be read.") {
    super(message);
    this.name = "PasswordDecryptionError";
  }
}

/* ── Encryption key ──────────────────────────────────────────── */

/**
 * Decode and validate the AES key from the environment.
 *
 * The key is NEVER generated at runtime: a missing or malformed key is a hard
 * configuration error so we can never silently encrypt data that a restarted
 * server could no longer decrypt.
 *
 * Accepted input: base64 or base64url that decodes to exactly 32 bytes
 * (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
 */
function getEncryptionKey(): Buffer {
  const raw = process.env[ENCRYPTION_KEY_ENV];
  if (!raw || !raw.trim()) {
    throw new PasswordConfigError(
      `${ENCRYPTION_KEY_ENV} is not defined in the environment. ` +
        `Add a base64-encoded 32-byte key to your .env.local file at the project root.`
    );
  }

  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new PasswordConfigError(
      `${ENCRYPTION_KEY_ENV} must be base64 (or base64url) encoded.`
    );
  }

  const key = Buffer.from(normalized, "base64");
  if (key.length !== KEY_BYTES) {
    throw new PasswordConfigError(
      `${ENCRYPTION_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes ` +
        `(received: ${key.length} bytes). Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  // Reject strings that Buffer silently "fixes" (stray padding/characters).
  if (key.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new PasswordConfigError(
      `${ENCRYPTION_KEY_ENV} is not valid base64 encoding of a ${KEY_BYTES}-byte key.`
    );
  }

  return key;
}

/** True when the encryption key is present and well-formed (for health checks). */
export function hasValidEncryptionKey(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/* ── AES-256-GCM ─────────────────────────────────────────────── */

/** True when `stored` matches the versioned AES ciphertext format. */
export function isEncryptedAdminPassword(stored: unknown): stored is string {
  return typeof stored === "string" && CIPHERTEXT_PATTERN.test(stored);
}

/**
 * Encrypt a plaintext password with AES-256-GCM.
 *
 * A fresh cryptographically secure random IV is generated per call, and the
 * GCM authentication tag is preserved inside the returned string.
 */
export function encryptAdminPassword(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new PasswordConfigError("Cannot encrypt an empty password.");
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    CIPHERTEXT_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a versioned AES-256-GCM ciphertext.
 *
 * GCM authentication runs during final(): tampered data, a wrong key, or a
 * malformed record throws `PasswordDecryptionError` (or `PasswordConfigError`
 * when the server key itself is misconfigured).
 */
export function decryptAdminPassword(stored: string): string {
  if (!isEncryptedAdminPassword(stored)) {
    throw new PasswordDecryptionError("Unsupported admin credential format.");
  }

  const [, ivPart, tagPart, dataPart] = stored.split(":");

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(ivPart, "base64");
    const authTag = Buffer.from(tagPart, "base64");
    const ciphertext = Buffer.from(dataPart, "base64");

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new PasswordDecryptionError();
    }

    const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(), // throws when the auth tag does not verify
    ]).toString("utf8");
  } catch (error) {
    // Never surface crypto internals (or the stored value) to the caller.
    if (error instanceof PasswordConfigError) throw error;
    throw new PasswordDecryptionError();
  }
}

/**
 * Constant-time string comparison.
 *
 * Inputs are hashed first so the comparison is independent of length (a raw
 * `timingSafeEqual` throws on different lengths, leaking the length).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/* ── bcrypt (Super Admin) ────────────────────────────────────── */

/** Hash a Super Admin password one-way with bcrypt. Never reversible. */
export async function hashSuperAdminPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_SALT_ROUNDS);
}

/** Verify a Super Admin password against a stored bcrypt hash. */
export async function verifySuperAdminPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  if (typeof hash !== "string" || !hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    // Malformed hash — treat as a failed login, never as a match.
    return false;
  }
}

/* ── Scheme resolution & verification ────────────────────────── */

export interface AdminPasswordRecord {
  password?: string | null;
  passwordScheme?: string | null;
  role?: string | null;
}

/**
 * Resolve which algorithm protects a stored record.
 *
 * Legacy accounts (created before `passwordScheme` existed) are treated as
 * bcrypt. The ciphertext format is also checked, so a record that claims
 * "aes-256-gcm" but still holds a bcrypt hash (e.g. a default applied to an
 * unmigrated document) safely falls back to bcrypt instead of failing to
 * decrypt.
 */
export function resolveAdminPasswordScheme(
  record: AdminPasswordRecord
): AdminPasswordScheme {
  if (
    record.passwordScheme === ADMIN_PASSWORD_SCHEME_AES &&
    isEncryptedAdminPassword(record.password)
  ) {
    return ADMIN_PASSWORD_SCHEME_AES;
  }
  return ADMIN_PASSWORD_SCHEME_BCRYPT;
}

/** True for the role whose passwords are AES-encrypted (and recoverable). */
export function isRecoverableAdminRole(role?: string | null): boolean {
  return role !== "super_admin";
}

export type AdminPasswordVerification =
  | { ok: true; scheme: AdminPasswordScheme; needsMigration: boolean }
  | { ok: false };

/**
 * Verify a submitted password against the stored record using the scheme that
 * actually protects it.
 *
 * `needsMigration` is true when a bcrypt-protected NORMAL admin authenticated
 * successfully — the caller should then upgrade the record via
 * `migrateLegacyAdminPassword()`.
 *
 * Never logs anything. Returns `{ ok: false }` for any authentication failure,
 * including unreadable/tampered ciphertext.
 */
export async function verifyAdminPassword(
  submitted: string,
  record: AdminPasswordRecord
): Promise<AdminPasswordVerification> {
  if (typeof submitted !== "string" || submitted.length === 0) return { ok: false };

  const scheme = resolveAdminPasswordScheme(record);
  const stored = record.password;
  if (typeof stored !== "string" || stored.length === 0) return { ok: false };

  if (scheme === ADMIN_PASSWORD_SCHEME_AES) {
    let decrypted: string;
    try {
      decrypted = decryptAdminPassword(stored);
    } catch (error) {
      if (error instanceof PasswordConfigError) throw error; // server misconfiguration
      return { ok: false }; // tampered / unreadable ciphertext
    }

    return constantTimeEqual(decrypted, submitted)
      ? { ok: true, scheme, needsMigration: false }
      : { ok: false };
  }

  const matches = await verifySuperAdminPassword(submitted, stored);
  if (!matches) return { ok: false };

  return {
    ok: true,
    scheme,
    // Only normal admins are migrated; Super Admins stay on bcrypt forever.
    needsMigration: isRecoverableAdminRole(record.role),
  };
}

/* ── Legacy migration ────────────────────────────────────────── */

/** Minimal shape of a Mongoose Admin document, kept structural to avoid a circular import. */
export interface MigratableAdminDocument {
  password: string;
  passwordScheme?: string | null;
  role?: string | null;
  save(): Promise<unknown>;
}

/**
 * Upgrade a legacy (bcrypt) normal Admin to AES-256-GCM storage.
 *
 * MUST only be called after the submitted plaintext has been verified with
 * bcrypt. The bcrypt hash is never reversed — the already-verified plaintext is
 * re-encrypted and the document is persisted.
 *
 * Returns true when the record was migrated. No-ops (returns false) for Super
 * Admins and for accounts already on AES-256-GCM.
 */
export async function migrateLegacyAdminPassword(
  admin: MigratableAdminDocument,
  plaintext: string
): Promise<boolean> {
  if (!isRecoverableAdminRole(admin.role)) return false;
  if (resolveAdminPasswordScheme(admin) !== ADMIN_PASSWORD_SCHEME_BCRYPT) return false;
  if (typeof plaintext !== "string" || plaintext.length === 0) return false;

  admin.password = encryptAdminPassword(plaintext); // throws if the key is invalid
  admin.passwordScheme = ADMIN_PASSWORD_SCHEME_AES;
  await admin.save();
  return true;
}

/* ── Password generation & validation ────────────────────────── */

/** Unambiguous charset (no 0/O/1/l/I) for passwords a human may retype. */
const GENERATED_PASSWORD_CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";

/**
 * Generate a cryptographically secure random password.
 * Uses `crypto.randomInt` (never Math.random) with rejection-free uniform picks.
 */
export function generateAdminPassword(length = 16): string {
  const size = Math.max(MIN_ADMIN_PASSWORD_LENGTH, Math.floor(length));
  let password = "";
  for (let i = 0; i < size; i += 1) {
    password += GENERATED_PASSWORD_CHARSET.charAt(
      crypto.randomInt(0, GENERATED_PASSWORD_CHARSET.length)
    );
  }
  return password;
}

/** Validate a Super Admin supplied password. Returns an error message or null. */
export function validateAdminPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) {
    return "Password is required.";
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) {
    return "Password must be at most 200 characters.";
  }
  return null;
}
