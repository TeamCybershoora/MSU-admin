/**
 * Controlled Super Admin bootstrap / promotion.
 *
 * There is no API that can create or promote a Super Admin — that deliberately
 * runs only from the server (this script), so an admin session can never mint
 * one. Credentials are supplied through the environment and are never printed.
 *
 * Usage:
 *   # Create a brand-new Super Admin
 *   SUPER_ADMIN_EMAIL=root@msu.ac.in \
 *   SUPER_ADMIN_PASSWORD='a-strong-password' \
 *   SUPER_ADMIN_NAME="Portal Owner" \
 *   npx tsx scripts/create-super-admin.ts
 *
 *   # Promote an EXISTING admin (keeps _id, email, name, role history, timestamps)
 *   SUPER_ADMIN_EMAIL=existing@msu.ac.in npx tsx scripts/create-super-admin.ts
 *
 * Promotion behaviour:
 * - The account is modified IN PLACE — never deleted and recreated, so its _id,
 *   email, name, status, lastLogin and createdAt are preserved.
 * - The password is re-hashed with bcrypt (one-way), which is mandatory for
 *   Super Admins and permanently removes the ability to recover it.
 * - If no SUPER_ADMIN_PASSWORD is given and the account still holds a
 *   recoverable AES-256-GCM password, that existing password is reused: it is
 *   decrypted server-side, re-hashed, and never displayed.
 * - `passwordChangedAt` is stamped so JWT sessions issued before the promotion
 *   stop working.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import connectDB from "@/lib/mongodb";
import Admin from "@/models/Admin";
import {
  MIN_ADMIN_PASSWORD_LENGTH,
  PasswordConfigError,
  decryptAdminPassword,
  hashSuperAdminPassword,
  resolveAdminPasswordScheme,
} from "@/lib/password";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`Error: ${name} is not defined in the environment.`);
    console.error(
      "Set it in your .env.local file or export it before running this script."
    );
    process.exit(1);
  }
  return value.trim();
}

async function main(): Promise<void> {
  const email = getRequiredEnv("SUPER_ADMIN_EMAIL").toLowerCase();
  const name = (process.env.SUPER_ADMIN_NAME || "Super Admin").trim();
  const providedPassword = (process.env.SUPER_ADMIN_PASSWORD || "").trim();

  if (providedPassword && providedPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    console.error(
      `Error: SUPER_ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`
    );
    process.exit(1);
  }

  await connectDB();

  const existing = await Admin.findOne({ email }).select("+password");

  if (!existing) {
    if (!providedPassword) {
      console.error(
        "Error: SUPER_ADMIN_PASSWORD is required when creating a new Super Admin."
      );
      process.exit(1);
    }

    const passwordHash = await hashSuperAdminPassword(providedPassword);

    await Admin.create({
      name,
      email,
      password: passwordHash,
      passwordScheme: "bcrypt",
      role: "super_admin",
      status: "active",
    });

    console.log(`Super Admin created for ${email} (bcrypt-hashed).`);
    process.exit(0);
  }

  // ── Promote an existing account in place ──────────────────────────────
  const scheme = resolveAdminPasswordScheme(existing);

  let plaintext = providedPassword;
  if (!plaintext) {
    if (scheme !== "aes-256-gcm") {
      console.error(
        "Error: this account already stores a one-way bcrypt hash, so its password " +
          "cannot be reused for promotion."
      );
      console.error(
        "Provide SUPER_ADMIN_PASSWORD to set a new Super Admin password."
      );
      process.exit(1);
    }

    // Recover the existing (reversible) password so the admin can keep using
    // it. The value is never logged or printed.
    try {
      plaintext = decryptAdminPassword(existing.password);
      console.log(
        "Reusing the account's existing recoverable password (value not displayed)."
      );
    } catch (error) {
      if (error instanceof PasswordConfigError) {
        console.error(
          "Error: ADMIN_PASSWORD_ENCRYPTION_KEY is missing or invalid, so the " +
            "existing password cannot be recovered."
        );
      } else {
        console.error(
          "Error: the stored password could not be read. Provide SUPER_ADMIN_PASSWORD instead."
        );
      }
      process.exit(1);
    }
  }

  const previousRole = existing.role;

  existing.role = "super_admin";
  existing.password = await hashSuperAdminPassword(plaintext);
  existing.passwordScheme = "bcrypt";
  existing.passwordChangedAt = new Date();
  await existing.save();

  console.log(
    `Promoted ${email} in place (${previousRole} → super_admin). ` +
      `Account _id, email, name, status and timestamps are unchanged; ` +
      `the password is now bcrypt-hashed and cannot be recovered.`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to create/promote Super Admin:", error);
  process.exit(1);
});
