/**
 * End-to-end verification of the Admin Portal password redesign.
 *
 * Creates THREE temporary accounts in the configured MongoDB database, verifies
 * every behaviour from the migration/security checklist over the real API, then
 * deletes exactly those accounts again.
 *
 * Safety:
 * - Temporary accounts use a random `codebuff-verify-<hex>-*@example.invalid`
 *   email address.
 * - Cleanup deletes ONLY those exact email addresses ($in on the generated
 *   list) — no existing admin is read, modified or deleted.
 * - No password, key or ciphertext is ever printed.
 *
 * Usage:
 *   npm run build
 *   npx next start -p 3099          # in another terminal
 *   npx tsx scripts/test-admin-auth-db.ts
 *
 * Note: every endpoint is rate limited in memory per client IP (login: 10
 * attempts / 15 min). Each section below presents its own synthetic
 * `x-forwarded-for` address — the header the limiter reads for proxied
 * requests — so no section can exhaust another's budget and the script can be
 * re-run without waiting for a window to roll over.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import crypto from "crypto";
import connectDB from "@/lib/mongodb";
import Admin from "@/models/Admin";
import ActivityLog from "@/models/ActivityLog";
import {
  encryptAdminPassword,
  generateAdminPassword,
  hashSuperAdminPassword,
} from "@/lib/password";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3099";

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

const suffix = crypto.randomBytes(6).toString("hex");
const EMAILS = {
  legacy: `codebuff-verify-${suffix}-legacy@example.invalid`,
  aes: `codebuff-verify-${suffix}-aes@example.invalid`,
  superAdmin: `codebuff-verify-${suffix}-super@example.invalid`,
};
const TEMP_EMAILS = Object.values(EMAILS);

/** Ids of the accounts seeded by this run — used by the failure-path cleanup. */
let seededIds: unknown[] = [];

const PASSWORDS = {
  legacy: generateAdminPassword(),
  aes: generateAdminPassword(),
  superAdmin: generateAdminPassword(),
  rotated: generateAdminPassword(),
};

/**
 * Client IP presented to the server. The rate limiters key on
 * `x-forwarded-for` (see lib/rate-limit.ts), so each section claims its own
 * synthetic address to stay inside the per-IP request budgets.
 */
let clientIp = "203.0.113.10";

function setClientIp(ip: string) {
  clientIp = ip;
}

/** Raw driver read — bypasses the schema so legacy documents look untouched. */
async function rawAdmin(email: string) {
  return Admin.collection.findOne({ email });
}

async function login(email: string, password: string) {
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": clientIp,
    },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json, text };
}

async function api(
  path: string,
  token: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: unknown
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-forwarded-for": clientIp,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  // Imported dynamically: auth-helpers reads JWT_SECRET at module load, so it
  // must be imported AFTER dotenv has populated process.env.
  const { generateAdminToken } = await import("@/lib/auth-helpers");

  console.log(`Verifying against ${BASE} (temporary accounts, removed at the end)`);

  await connectDB();

  // Safety valve: confirm no temporary verification account was left behind.
  if (process.argv.includes("--verify-clean")) {
    const leftovers = await Admin.collection.countDocuments({
      email: { $regex: /^codebuff-verify-/ },
    });
    const logCount = await ActivityLog.collection.countDocuments({});
    console.log(`Temporary verification accounts remaining: ${leftovers}`);
    console.log(`Total activity log entries (informational): ${logCount}`);
    process.exit(leftovers === 0 ? 0 : 1);
  }

  // ── Seed three temporary accounts ───────────────────────────────────────
  const legacyId = (await Admin.collection.insertOne({
    name: "Temp Legacy Admin",
    email: EMAILS.legacy,
    // Legacy shape: bcrypt hash and NO passwordScheme field at all.
    password: await hashSuperAdminPassword(PASSWORDS.legacy),
    role: "admin",
    status: "active",
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    __v: 0,
  })).insertedId;

  const aesCiphertext = encryptAdminPassword(PASSWORDS.aes);
  const aesId = (await Admin.collection.insertOne({
    name: "Temp AES Admin",
    email: EMAILS.aes,
    password: aesCiphertext,
    passwordScheme: "aes-256-gcm",
    role: "admin",
    status: "active",
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    __v: 0,
  })).insertedId;

  const superHash = await hashSuperAdminPassword(PASSWORDS.superAdmin);
  const superId = (await Admin.collection.insertOne({
    name: "Temp Super Admin",
    email: EMAILS.superAdmin,
    password: superHash,
    passwordScheme: "bcrypt",
    role: "super_admin",
    status: "active",
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    __v: 0,
  })).insertedId;

  const legacyBefore = await rawAdmin(EMAILS.legacy);
  const superBefore = await rawAdmin(EMAILS.superAdmin);
  const TEMP_IDS = [legacyId, aesId, superId];
  seededIds = TEMP_IDS;

  try {
    /* ── Legacy bcrypt normal admin login + migration ─────────────────── */
    section("Legacy bcrypt normal admin");
    setClientIp("203.0.113.11");
    const legacyLogin = await login(EMAILS.legacy, PASSWORDS.legacy);
    check("legacy bcrypt admin can still log in", legacyLogin.status === 200);
    check(
      "login response contains no password field",
      !legacyLogin.text.toLowerCase().includes('"password"')
    );

    const legacyAfter = await rawAdmin(EMAILS.legacy);
    check(
      "legacy login migrated the record to AES-256-GCM",
      legacyAfter?.passwordScheme === "aes-256-gcm" &&
        typeof legacyAfter?.password === "string" &&
        legacyAfter.password.startsWith("v1:")
    );
    check(
      "migration preserved _id",
      String(legacyAfter?._id) === String(legacyBefore?._id)
    );
    check("migration preserved email", legacyAfter?.email === EMAILS.legacy);
    check("migration preserved name", legacyAfter?.name === legacyBefore?.name);
    check(
      "migration preserved createdAt",
      new Date(legacyAfter?.createdAt).getTime() ===
        new Date(legacyBefore?.createdAt).getTime()
    );
    check(
      "no plaintext password was stored in a second field",
      !Object.values(legacyAfter as Record<string, unknown>).includes(
        PASSWORDS.legacy
      )
    );

    const legacyWrong = await login(EMAILS.legacy, "definitely-not-it");
    check("wrong password after migration is rejected", legacyWrong.status === 401);

    /* ── AES-256-GCM normal admin ─────────────────────────────────────── */
    section("AES-256-GCM normal admin");
    setClientIp("203.0.113.12");
    const aesLogin = await login(EMAILS.aes, PASSWORDS.aes);
    check("AES-encrypted normal admin can log in", aesLogin.status === 200);

    const aesDoc = await rawAdmin(EMAILS.aes);
    check(
      "AES admin password is still stored as ciphertext",
      typeof aesDoc?.password === "string" && aesDoc.password.startsWith("v1:")
    );

    // Tamper with the stored ciphertext, then restore it.
    const tampered =
      aesCiphertext.slice(0, -1) + (aesCiphertext.endsWith("A") ? "B" : "A");
    await Admin.collection.updateOne({ _id: aesId }, { $set: { password: tampered } });
    const tamperedLogin = await login(EMAILS.aes, PASSWORDS.aes);
    check("tampered ciphertext fails authentication (401)", tamperedLogin.status === 401);
    await Admin.collection.updateOne({ _id: aesId }, { $set: { password: aesCiphertext } });

    const restoredLogin = await login(EMAILS.aes, PASSWORDS.aes);
    check("restored ciphertext authenticates again", restoredLogin.status === 200);

    /* ── Super Admin (bcrypt) ─────────────────────────────────────────── */
    section("Super Admin (bcrypt)");
    setClientIp("203.0.113.13");
    const superLogin = await login(EMAILS.superAdmin, PASSWORDS.superAdmin);
    check("Super Admin can log in", superLogin.status === 200);

    const superAfter = await rawAdmin(EMAILS.superAdmin);
    check(
      "Super Admin password stays a bcrypt hash (never migrated)",
      superAfter?.password === superBefore?.password &&
        superAfter?.passwordScheme === "bcrypt"
    );

    const superToken =
      (superLogin.json.token as string | undefined) ??
      generateAdminToken(String(superId), "super_admin");
    const aesToken =
      (restoredLogin.json.token as string | undefined) ??
      generateAdminToken(String(aesId), "admin");
    const legacyToken = legacyLogin.json.token as string;

    /* ── Authorization boundaries ─────────────────────────────────────── */
    section("Server-side authorization");
    setClientIp("203.0.113.14");
    const listAsNormal = await api("/api/admin/admins", aesToken);
    check("normal admin gets 403 on the admin list", listAsNormal.status === 403);

    const listAsLegacy = await api("/api/admin/admins", legacyToken);
    check("migrated normal admin still gets 403 on the admin list", listAsLegacy.status === 403);

    const listAsSuper = await api("/api/admin/admins", superToken);
    check("Super Admin can list admins", listAsSuper.status === 200);
    check(
      "admin list never includes password material",
      !listAsSuper.text.toLowerCase().includes('"password"') &&
        !listAsSuper.text.includes(aesCiphertext) &&
        !listAsSuper.text.includes(PASSWORDS.aes) &&
        !listAsSuper.text.includes(superHash)
    );

    /* ── Reveal ───────────────────────────────────────────────────────── */
    section("Password reveal");
    setClientIp("203.0.113.15");
    const revealAsNormal = await api(
      `/api/admin/admins/${String(aesId)}/reveal`,
      aesToken,
      "POST",
      { confirm: true }
    );
    check("normal admin gets 403 revealing a password", revealAsNormal.status === 403);

    const revealWithoutConfirm = await api(
      `/api/admin/admins/${String(aesId)}/reveal`,
      superToken,
      "POST",
      {}
    );
    check(
      "reveal without explicit confirmation is refused",
      revealWithoutConfirm.status === 400
    );

    const revealAes = await api(
      `/api/admin/admins/${String(aesId)}/reveal`,
      superToken,
      "POST",
      { confirm: true }
    );
    check("Super Admin can reveal a normal admin password", revealAes.status === 200);
    check(
      "revealed password matches the stored credential",
      (revealAes.json.data as { password?: string } | undefined)?.password ===
        PASSWORDS.aes
    );
    check(
      "reveal response is not cacheable (Cache-Control: no-store)",
      (revealAes.headers.get("cache-control") || "").includes("no-store")
    );

    const revealSuper = await api(
      `/api/admin/admins/${String(superId)}/reveal`,
      superToken,
      "POST",
      { confirm: true }
    );
    check("revealing a Super Admin password returns 403", revealSuper.status === 403);

    /* ── Normal admin changes their own password ──────────────────────── */
    section("Normal admin changes their own password");
    setClientIp("203.0.113.16");

    const changeMismatch = await api("/api/admin/change-password", aesToken, "POST", {
      currentPassword: PASSWORDS.aes,
      newPassword: PASSWORDS.rotated,
      confirmNewPassword: "something-else-entirely",
    });
    check("mismatched confirmation is rejected", changeMismatch.status === 400);

    const changeWrongCurrent = await api("/api/admin/change-password", aesToken, "POST", {
      currentPassword: "not-the-current-password",
      newPassword: PASSWORDS.rotated,
      confirmNewPassword: PASSWORDS.rotated,
    });
    check("wrong current password is rejected", changeWrongCurrent.status === 401);

    const changeTooShort = await api("/api/admin/change-password", aesToken, "POST", {
      currentPassword: PASSWORDS.aes,
      newPassword: "short",
      confirmNewPassword: "short",
    });
    check("new password shorter than 8 characters is rejected", changeTooShort.status === 400);

    const changeAsSuperAdmin = await api(
      "/api/admin/change-password",
      superToken,
      "POST",
      {
        currentPassword: PASSWORDS.superAdmin,
        newPassword: PASSWORDS.rotated,
        confirmNewPassword: PASSWORDS.rotated,
      }
    );
    check(
      "Super Admin cannot use the normal-admin change endpoint (403)",
      changeAsSuperAdmin.status === 403
    );

    // Wait out the one-second JWT `iat` grace so the pre-change token is
    // unambiguously older than passwordChangedAt.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const selfChange = await api("/api/admin/change-password", aesToken, "POST", {
      currentPassword: PASSWORDS.aes,
      newPassword: PASSWORDS.rotated,
      confirmNewPassword: PASSWORDS.rotated,
    });
    check("normal admin can change their own password", selfChange.status === 200);
    check(
      "the new password is never echoed back",
      !selfChange.text.includes(PASSWORDS.rotated)
    );

    const afterSelfChange = await rawAdmin(EMAILS.aes);
    check(
      "self-changed password is stored as AES-256-GCM ciphertext",
      afterSelfChange?.passwordScheme === "aes-256-gcm" &&
        typeof afterSelfChange?.password === "string" &&
        afterSelfChange.password.startsWith("v1:")
    );
    check(
      "the previous credential was replaced (one password source only)",
      afterSelfChange?.password !== aesCiphertext
    );
    check(
      "self-change preserved the account identity",
      String(afterSelfChange?._id) === String(aesId) &&
        afterSelfChange?.email === EMAILS.aes &&
        afterSelfChange?.name === "Temp AES Admin" &&
        afterSelfChange?.role === "admin"
    );

    const selfToken = selfChange.json.token as string;
    const staleAfterSelfChange = await api("/api/admin/admins", aesToken);
    check(
      "sessions from before the self-change are rejected",
      staleAfterSelfChange.status === 401
    );
    const refreshedSession = await api("/api/admin/admins", selfToken);
    check(
      "the re-issued session token is valid (403 = authenticated normal admin)",
      refreshedSession.status === 403
    );

    const oldSelfPasswordLogin = await login(EMAILS.aes, PASSWORDS.aes);
    check("the admin's previous password stops working", oldSelfPasswordLogin.status === 401);

    const newSelfPasswordLogin = await login(EMAILS.aes, PASSWORDS.rotated);
    check("the admin can log in with the new password", newSelfPasswordLogin.status === 200);

    const revealSelfChanged = await api(
      `/api/admin/admins/${String(aesId)}/reveal`,
      superToken,
      "POST",
      { confirm: true }
    );
    check(
      "Super Admin recovers the admin's LATEST (self-changed) password",
      (revealSelfChanged.json.data as { password?: string } | undefined)?.password ===
        PASSWORDS.rotated
    );

    /* ── Reset ────────────────────────────────────────────────────────── */
    section("Password reset");
    setClientIp("203.0.113.17");
    const resetSuper = await api(
      `/api/admin/admins/${String(superId)}/password`,
      superToken,
      "POST",
      { password: PASSWORDS.rotated }
    );
    check("resetting another Super Admin returns 403", resetSuper.status === 403);

    // Give the pre-reset session token a full second of age: JWT `iat` has
    // one-second granularity, and authenticateAdmin allows one second of grace.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const resetNormal = await api(
      `/api/admin/admins/${String(aesId)}/password`,
      superToken,
      "POST",
      { password: PASSWORDS.rotated }
    );
    check("Super Admin can reset a normal admin password", resetNormal.status === 200);
    check(
      "a typed password is not echoed back",
      !resetNormal.text.includes(PASSWORDS.rotated)
    );

    const resetDoc = await rawAdmin(EMAILS.aes);
    check(
      "reset password is stored as AES-256-GCM ciphertext",
      resetDoc?.passwordScheme === "aes-256-gcm" &&
        typeof resetDoc?.password === "string" &&
        resetDoc.password.startsWith("v1:") &&
        resetDoc.password !== aesCiphertext
    );

    const oldPasswordLogin = await login(EMAILS.aes, PASSWORDS.aes);
    check("old password stops working after reset", oldPasswordLogin.status === 401);

    const newPasswordLogin = await login(EMAILS.aes, PASSWORDS.rotated);
    check("new password works after reset", newPasswordLogin.status === 200);

    const staleToken = await api("/api/admin/admins", selfToken);
    check(
      "sessions issued before the reset are rejected",
      staleToken.status === 401
    );

    const revealAfterReset = await api(
      `/api/admin/admins/${String(aesId)}/reveal`,
      superToken,
      "POST",
      { confirm: true }
    );
    check(
      "reveal returns the reset password",
      (revealAfterReset.json.data as { password?: string } | undefined)?.password ===
        PASSWORDS.rotated
    );

    /* ── Status toggling ──────────────────────────────────────────────── */
    section("Activate / deactivate");
    setClientIp("203.0.113.18");
    const patchSuper = await api(
      `/api/admin/admins/${String(superId)}`,
      superToken,
      "PATCH",
      { status: "inactive" }
    );
    check("deactivating a Super Admin returns 403", patchSuper.status === 403);

    const deactivate = await api(
      `/api/admin/admins/${String(aesId)}`,
      superToken,
      "PATCH",
      { status: "inactive" }
    );
    check("Super Admin can deactivate a normal admin", deactivate.status === 200);

    const inactiveLogin = await login(EMAILS.aes, PASSWORDS.rotated);
    check("deactivated admin cannot log in (403)", inactiveLogin.status === 403);

    const reactivate = await api(
      `/api/admin/admins/${String(aesId)}`,
      superToken,
      "PATCH",
      { status: "active" }
    );
    check("Super Admin can reactivate a normal admin", reactivate.status === 200);

    /* ── Create admin ─────────────────────────────────────────────────── */
    section("Create admin");
    setClientIp("203.0.113.19");
    const createdEmail = `codebuff-verify-${suffix}-created@example.invalid`;
    TEMP_EMAILS.push(createdEmail);

    // Fresh normal-admin token: the earlier one was invalidated by the reset.
    const currentNormalToken = newPasswordLogin.json.token as string;
    const createAsNormal = await api("/api/admin/admins", currentNormalToken, "POST", {
      name: "Nope",
      email: createdEmail,
    });
    check("normal admin gets 403 creating an admin", createAsNormal.status === 403);

    const createAsSuper = await api("/api/admin/admins", superToken, "POST", {
      name: "Temp Created Admin",
      email: createdEmail,
    });
    check("Super Admin can create a normal admin", createAsSuper.status === 200);

    const generatedPassword = (createAsSuper.json.generatedPassword as string) || "";
    const createdDoc = await rawAdmin(createdEmail);
    check(
      "created admin is stored with AES-256-GCM",
      createdDoc?.passwordScheme === "aes-256-gcm" &&
        typeof createdDoc?.password === "string" &&
        createdDoc.password.startsWith("v1:")
    );
    check("created admin has role \"admin\"", createdDoc?.role === "admin");

    const generatedLogin = await login(createdEmail, generatedPassword);
    check("generated password works for the new admin", generatedLogin.status === 200);

    // A created normal admin has no Super Admin rights.
    const createdToken = generatedLogin.json.token as string;
    const createdList = await api("/api/admin/admins", createdToken);
    check("created normal admin gets 403 on the admin list", createdList.status === 403);

    /* ── Activity log ─────────────────────────────────────────────────── */
    section("Activity log");

    const logDocs = await ActivityLog.collection.find({
      $or: [
        { targetAdminId: { $in: TEMP_IDS } },
        { actorAdminId: { $in: TEMP_IDS } },
      ],
    }).toArray();

    const loggedActions = logDocs.map((doc) => doc.action as string);
    check(
      "self password change is recorded as an event",
      loggedActions.includes("admin.password.changed")
    );
    check(
      "Super Admin reset is recorded as an event",
      loggedActions.includes("admin.password.reset")
    );
    check(
      "password recovery is recorded as an event",
      loggedActions.includes("admin.password.viewed")
    );

    const serializedLog = JSON.stringify(logDocs);
    const secrets = [
      PASSWORDS.legacy,
      PASSWORDS.aes,
      PASSWORDS.superAdmin,
      PASSWORDS.rotated,
      aesCiphertext,
      superHash,
    ];
    check(
      "no password, hash or ciphertext appears in the activity log",
      secrets.every((secret) => !serializedLog.includes(secret))
    );

    const allowedKeys = [
      "_id",
      "action",
      "actorAdminId",
      "targetAdminId",
      "createdAt",
      "updatedAt",
      "__v",
    ];
    check(
      "log entries carry only action/actor/target/timestamp fields",
      logDocs.length > 0 &&
        logDocs.every((doc) =>
          Object.keys(doc).every((key) => allowedKeys.includes(key))
        )
    );

    const changedEvent = logDocs.find(
      (doc) => doc.action === "admin.password.changed"
    );
    check(
      "the self-change event names the admin as both actor and target",
      String(changedEvent?.actorAdminId) === String(aesId) &&
        String(changedEvent?.targetAdminId) === String(aesId)
    );
    check(
      "every log entry has a timestamp",
      logDocs.every((doc) => doc.createdAt instanceof Date)
    );
    check(
      "the legacy bcrypt migration did not write an audit event",
      !logDocs.some(
        (doc) => String(doc.targetAdminId) === String(legacyId)
      )
    );

  } finally {
    /* ── Cleanup: only the temporary accounts created above ──────────── */
    const cleanup = await Admin.collection.deleteMany({
      email: { $in: TEMP_EMAILS },
    });
    console.log(
      `\nCleaned up ${cleanup.deletedCount} temporary account(s) (existing admins untouched).`
    );
    console.log(
      `Temp _ids: ${[legacyId, aesId, superId].filter(Boolean).length} seeded`
    );

    const logsRemoved = await ActivityLog.collection.deleteMany({
      $or: [
        { targetAdminId: { $in: TEMP_IDS } },
        { actorAdminId: { $in: TEMP_IDS } },
      ],
    });
    console.log(
      `Cleaned up ${logsRemoved.deletedCount} temporary activity log entr${
        logsRemoved.deletedCount === 1 ? "y" : "ies"
      }.`
    );

    const leftovers = await Admin.collection.countDocuments({
      email: { $regex: /^codebuff-verify-/ },
    });
    check("no temporary verification account remains", leftovers === 0, `${leftovers} left`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {    console.error("Verification run failed:", error);
  try {
    await Admin.collection.deleteMany({ email: { $in: TEMP_EMAILS } });
    if (seededIds.length > 0) {
      await ActivityLog.collection.deleteMany({
        $or: [
          { targetAdminId: { $in: seededIds } },
          { actorAdminId: { $in: seededIds } },
        ],
      });
    }
    console.error("Temporary accounts and log entries cleaned up after failure.");
  } catch {
    console.error("Cleanup after failure also failed — check the temp accounts manually.");
  }
  process.exit(1);
});
