import mongoose, { Schema, type Document } from "mongoose";
import {
  ADMIN_PASSWORD_SCHEME_AES,
  ADMIN_PASSWORD_SCHEME_BCRYPT,
  resolveAdminPasswordScheme,
  type AdminPasswordScheme,
} from "@/lib/password";

/**
 * Admin model — stores admin user accounts for the Admin Portal.
 *
 * One document per admin user:
 * - "admin" (default) — normal admin. Passwords are AES-256-GCM encrypted so
 *   an authorized Super Admin can recover them (see lib/password.ts).
 * - "super_admin" — elevated access. Passwords are bcrypt-hashed and must
 *   never be decryptable or displayed.
 *
 * `passwordScheme` records which algorithm protects the stored `password`:
 * - "aes-256-gcm" — reversible ciphertext (normal admins)
 * - "bcrypt"      — one-way hash (super admins, and every legacy account)
 *
 * Records created before `passwordScheme` existed have no value and are treated
 * as bcrypt until they migrate on a successful login.
 */

export type AdminRole = "admin" | "super_admin";
export type AdminStatus = "active" | "inactive";
export type { AdminPasswordScheme };

export interface IAdmin extends Document {
  name: string;
  email: string;
  password: string;
  passwordScheme: AdminPasswordScheme;
  role: AdminRole;
  status: AdminStatus;
  lastLogin: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const adminSchema = new Schema<IAdmin>(
  {
    name: {
      type: String,
      required: [true, "Admin name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: "Please enter a valid email address.",
      },
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    passwordScheme: {
      type: String,
      enum: [ADMIN_PASSWORD_SCHEME_AES, ADMIN_PASSWORD_SCHEME_BCRYPT],
      // Intentionally NO schema `default`: a default would be applied to legacy
      // documents on hydration and would mislabel an existing bcrypt hash as
      // AES ciphertext. New documents are assigned a scheme by the hook below.
    },
    role: {
      type: String,
      enum: ["admin", "super_admin"],
      default: "admin",
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    /**
     * Set when a Super Admin resets a password. Any JWT issued before this
     * timestamp is rejected by authenticateAdmin(), invalidating sessions that
     * were created with the old password.
     */
    passwordChangedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Keep `passwordScheme` consistent with the account role.
 *
 * - Super Admins are always bcrypt (never reversible).
 * - New normal admins default to AES-256-GCM.
 * - Existing documents without a scheme are left untouched (treated as bcrypt
 *   by resolveAdminPasswordScheme) so legacy hashes are never mislabeled.
 */
adminSchema.pre("validate", function () {
  if (this.role === "super_admin") {
    if (this.passwordScheme !== ADMIN_PASSWORD_SCHEME_BCRYPT) {
      this.passwordScheme = ADMIN_PASSWORD_SCHEME_BCRYPT;
    }
    return;
  }

  if (this.isNew && !this.passwordScheme) {
    this.passwordScheme = ADMIN_PASSWORD_SCHEME_AES;
  }
});

/**
 * Return safe admin data (no password, no ciphertext, no hash).
 *
 * `passwordScheme` is reported through resolveAdminPasswordScheme() so a legacy
 * record is described as "bcrypt" even though the field is absent in MongoDB.
 */
export function toSafeAdmin(admin: IAdmin) {
  return {
    id: admin._id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    status: admin.status,
    passwordScheme: resolveAdminPasswordScheme(admin),
    lastLogin: admin.lastLogin,
    createdAt: admin.createdAt,
  };
}

/**
 * Shape accepted by toAdminSummary() — works for hydrated documents and for
 * `.lean()` results.
 */
export interface AdminSummarySource {
  _id: unknown;
  name: string;
  email: string;
  role: AdminRole;
  status: AdminStatus;
  password?: string | null;
  passwordScheme?: string | null;
  lastLogin?: Date | null;
  createdAt?: Date | null;
}

/**
 * Admin-management summary for Super Admin endpoints.
 *
 * Fields are listed explicitly so the stored password can never leak through a
 * spread or an accidental `.lean()` passthrough — never spread the source
document into a response.
 *
 * `canRevealPassword` is true only for normal admins whose credential is AES
 * ciphertext; bcrypt-protected accounts are unrecoverable by design.
 */
export function toAdminSummary(admin: AdminSummarySource) {
  const passwordScheme = resolveAdminPasswordScheme(admin);

  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    role: admin.role,
    status: admin.status,
    passwordScheme,
    canRevealPassword:
      passwordScheme === ADMIN_PASSWORD_SCHEME_AES && admin.role !== "super_admin",
    lastLogin: admin.lastLogin ?? null,
    createdAt: admin.createdAt ?? null,
  };
}

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Admin =
  mongoose.models.Admin ||
  mongoose.model<IAdmin>("Admin", adminSchema);

export default Admin;
