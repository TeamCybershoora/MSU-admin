/**
 * Offline verification of lib/password.ts.
 *
 * Runs entirely in memory: it never connects to MongoDB and never prints a
 * password, an encryption key, or a ciphertext. It covers the AES-256-GCM round
 * trip, tamper detection, key validation, scheme resolution, legacy (bcrypt)
 * verification + migration, and the secure password generator.
 *
 * Usage: npx tsx scripts/test-password-helper.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import crypto from "crypto";
import {
  ADMIN_PASSWORD_SCHEME_AES,
  ADMIN_PASSWORD_SCHEME_BCRYPT,
  PasswordConfigError,
  PasswordDecryptionError,
  constantTimeEqual,
  decryptAdminPassword,
  encryptAdminPassword,
  generateAdminPassword,
  hashSuperAdminPassword,
  isEncryptedAdminPassword,
  migrateLegacyAdminPassword,
  resolveAdminPasswordScheme,
  validateAdminPassword,
  verifyAdminPassword,
  type MigratableAdminDocument,
} from "@/lib/password";

const ORIGINAL_KEY = process.env.ADMIN_PASSWORD_ENCRYPTION_KEY;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

async function throws(fn: () => unknown): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Minimal in-memory stand-in for a Mongoose Admin document. */
function fakeAdmin(
  password: string,
  role: string,
  passwordScheme?: string | null
): MigratableAdminDocument & { saves: number } {
  return {
    password,
    role,
    passwordScheme,
    saves: 0,
    async save() {
      this.saves += 1;
    },
  };
}

async function main() {
  if (!ORIGINAL_KEY) {
    console.error(
      "ADMIN_PASSWORD_ENCRYPTION_KEY is not set in .env.local — cannot run these checks."
    );
    process.exit(1);
  }

  /* ── Key configuration ─────────────────────────────────── */
  section("Encryption key configuration");
  check(
    "configured key decodes to 32 bytes",
    Buffer.from(ORIGINAL_KEY, "base64").length === 32
  );

  const otherKey = crypto.randomBytes(32).toString("base64");

  process.env.ADMIN_PASSWORD_ENCRYPTION_KEY = "";
  check(
    "missing key fails securely with a config error",
    (await throws(() => encryptAdminPassword("whatever"))) instanceof
      PasswordConfigError
  );

  process.env.ADMIN_PASSWORD_ENCRYPTION_KEY = Buffer.from(
    crypto.randomBytes(16)
  ).toString("base64");
  check(
    "non-32-byte key fails securely with a config error",
    (await throws(() => encryptAdminPassword("whatever"))) instanceof
      PasswordConfigError
  );

  process.env.ADMIN_PASSWORD_ENCRYPTION_KEY = "not base64 !!";
  check(
    "non-base64 key fails securely with a config error",
    (await throws(() => encryptAdminPassword("whatever"))) instanceof
      PasswordConfigError
  );

  process.env.ADMIN_PASSWORD_ENCRYPTION_KEY = ORIGINAL_KEY;

  /* ── AES-256-GCM ───────────────────────────────────────── */
  section("AES-256-GCM encryption");
  const plaintext = "Correct-Horse-Battery-9";
  const ciphertext = encryptAdminPassword(plaintext);

  const parts = ciphertext.split(":");
  check("versioned format v1:<iv>:<tag>:<data>", parts.length === 4 && parts[0] === "v1");
  check("matches the decodable ciphertext format", isEncryptedAdminPassword(ciphertext));
  check("12-byte IV", Buffer.from(parts[1], "base64").length === 12);
  check("16-byte authentication tag", Buffer.from(parts[2], "base64").length === 16);
  check("round trip returns the original plaintext", decryptAdminPassword(ciphertext) === plaintext);
  check("plaintext is not stored in the ciphertext", !ciphertext.includes(plaintext));

  const secondCiphertext = encryptAdminPassword(plaintext);
  check("a fresh random IV is used for every encryption", secondCiphertext !== ciphertext);
  check("both ciphertexts still decrypt", decryptAdminPassword(secondCiphertext) === plaintext);

  const tamperedData = (() => {
    const [v, iv, tag, data] = ciphertext.split(":");
    const bytes = Buffer.from(data, "base64");
    bytes[0] = bytes[0] ^ 0xff;
    return [v, iv, tag, bytes.toString("base64")].join(":");
  })();
  check(
    "tampered ciphertext fails authentication",
    (await throws(() => decryptAdminPassword(tamperedData))) instanceof
      PasswordDecryptionError
  );

  const tamperedTag = (() => {
    const [v, iv, tag, data] = ciphertext.split(":");
    const bytes = Buffer.from(tag, "base64");
    bytes[0] = bytes[0] ^ 0xff;
    return [v, iv, bytes.toString("base64"), data].join(":");
  })();
  check(
    "tampered auth tag fails authentication",
    (await throws(() => decryptAdminPassword(tamperedTag))) instanceof
      PasswordDecryptionError
  );

  process.env.ADMIN_PASSWORD_ENCRYPTION_KEY = otherKey;
  check(
    "a different key cannot decrypt the ciphertext",
    (await throws(() => decryptAdminPassword(ciphertext))) instanceof
      PasswordDecryptionError
  );
  process.env.ADMIN_PASSWORD_ENCRYPTION_KEY = ORIGINAL_KEY;

  check(
    "malformed stored value is rejected",
    (await throws(() => decryptAdminPassword("$2b$10$abcdefghijklmnopqrstuv"))) instanceof
      PasswordDecryptionError
  );
  check(
    "empty plaintext is rejected",
    (await throws(() => encryptAdminPassword(""))) instanceof PasswordConfigError
  );

  /* ── Constant-time comparison ──────────────────────────── */
  section("Constant-time comparison");
  check("equal strings compare equal", constantTimeEqual("abc", "abc"));
  check("different strings compare unequal", !constantTimeEqual("abc", "abd"));
  check("different lengths compare unequal", !constantTimeEqual("abc", "abcd"));

  /* ── Scheme resolution ─────────────────────────────────── */
  section("Scheme resolution (legacy records)");
  check(
    "missing passwordScheme is treated as bcrypt",
    resolveAdminPasswordScheme({ password: "$2b$10$legacyhash", role: "admin" }) ===
      ADMIN_PASSWORD_SCHEME_BCRYPT
  );
  check(
    "aes-256-gcm + valid ciphertext resolves to aes-256-gcm",
    resolveAdminPasswordScheme({ password: ciphertext, passwordScheme: "aes-256-gcm" }) ===
      ADMIN_PASSWORD_SCHEME_AES
  );
  check(
    "aes-256-gcm label over a bcrypt hash falls back to bcrypt",
    resolveAdminPasswordScheme({
      password: "$2b$10$legacyhash",
      passwordScheme: "aes-256-gcm",
    }) === ADMIN_PASSWORD_SCHEME_BCRYPT
  );

  /* ── Verification ──────────────────────────────────────── */
  section("Password verification");
  const aesRecord = { password: encryptAdminPassword(plaintext), passwordScheme: "aes-256-gcm", role: "admin" };
  const aesOk = await verifyAdminPassword(plaintext, aesRecord);
  check("AES: correct password accepted", aesOk.ok === true);
  check("AES: no migration needed", aesOk.ok === true && aesOk.needsMigration === false);
  check("AES: wrong password rejected", (await verifyAdminPassword("wrong", aesRecord)).ok === false);
  check(
    "AES: tampered ciphertext rejected",
    (await verifyAdminPassword(plaintext, { ...aesRecord, password: tamperedData })).ok === false
  );
  check("AES: empty password rejected", (await verifyAdminPassword("", aesRecord)).ok === false);

  const legacyHash = await hashSuperAdminPassword(plaintext);

  const legacyNormal = await verifyAdminPassword(plaintext, { password: legacyHash, role: "admin" });
  check("legacy normal admin (no scheme): correct password accepted", legacyNormal.ok === true);
  check(
    "legacy normal admin: flagged for AES migration",
    legacyNormal.ok === true && legacyNormal.needsMigration === true
  );
  check(
    "legacy normal admin: wrong password rejected",
    (await verifyAdminPassword("wrong", { password: legacyHash, role: "admin" })).ok === false
  );

  const legacySuper = await verifyAdminPassword(plaintext, {
    password: legacyHash,
    passwordScheme: "bcrypt",
    role: "super_admin",
  });
  check("Super Admin: bcrypt password accepted", legacySuper.ok === true);
  check(
    "Super Admin: never flagged for migration (stays one-way)",
    legacySuper.ok === true && legacySuper.needsMigration === false
  );

  /* ── Legacy migration ──────────────────────────────────── */
  section("Legacy bcrypt → AES-256-GCM migration");
  const doc = fakeAdmin(legacyHash, "admin");
  const migrated = await migrateLegacyAdminPassword(doc, plaintext);
  check("migration reported as performed", migrated === true);
  check("stored value is now AES ciphertext", isEncryptedAdminPassword(doc.password));
  check("passwordScheme updated to aes-256-gcm", doc.passwordScheme === ADMIN_PASSWORD_SCHEME_AES);
  check("document was persisted once", doc.saves === 1);
  check("original plaintext still authenticates after migration", decryptAdminPassword(doc.password) === plaintext);

  const superDoc = fakeAdmin(legacyHash, "super_admin");
  const superMigrated = await migrateLegacyAdminPassword(superDoc, plaintext);
  check("Super Admin is never migrated", superMigrated === false);
  check("Super Admin hash is untouched", superDoc.password === legacyHash);
  check("Super Admin document not saved", superDoc.saves === 0);

  const alreadyAes = fakeAdmin(encryptAdminPassword(plaintext), "admin", "aes-256-gcm");
  check(
    "already-encrypted record is not re-encrypted",
    (await migrateLegacyAdminPassword(alreadyAes, plaintext)) === false
  );

  /* ── Password generation / validation ──────────────────── */
  section("Password generation and validation");
  const generated = generateAdminPassword();
  check("generated password length", generated.length === 16);
  check("generated password respects a custom length", generateAdminPassword(24).length === 24);
  check("generated passwords are unique", generateAdminPassword() !== generateAdminPassword());
  check("no ambiguous characters (0/O/1/l/I)", !/[0O1lI]/.test(generateAdminPassword(64)));
  check("validateAdminPassword accepts a strong password", validateAdminPassword("longenough1") === null);
  check("validateAdminPassword rejects short passwords", validateAdminPassword("short") !== null);
  check("validateAdminPassword rejects empties", validateAdminPassword("") !== null);

  /* ── Summary ───────────────────────────────────────────── */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test run failed:", error);
  process.exit(1);
});
