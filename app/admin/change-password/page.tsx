"use client";

/**
 * Change Password Page — self-service password change for a NORMAL admin.
 *
 * Flow: Current Password → New Password → Confirm New Password.
 *
 * Data flow:
 *   1. POST /api/admin/change-password with the stored JWT
 *   2. Server re-authenticates the admin, verifies the current password with
 *      the scheme that protects the account (bcrypt if legacy, AES-256-GCM
 *      otherwise), then stores the new password AES-256-GCM encrypted
 *   3. Server returns a freshly issued JWT (the change invalidates every older
 *      session) which is written back to localStorage
 *
 * Security:
 * - The new password is never echoed back by the API and never stored in this
 *   page's state after a successful submit.
 * - Super Admin accounts are out of scope: their passwords are bcrypt-hashed
 *   and cannot be made reversible, so they see an explanatory notice (and the
 *   API answers 403 regardless of what the UI shows).
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken, getStoredRole)
 *   - @/components/ui/* (Card, CardHeader, Button)
 *   - POST /api/admin/change-password (server-side route)
 */

import { useState } from "react";
import { KeyRound, Lock, ShieldCheck, AlertTriangle, Check } from "lucide-react";
import { getStoredToken, useStoredRole } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import styles from "./page.module.css";

const MIN_PASSWORD_LENGTH = 8;

export default function ChangePasswordPage() {
  const role = useStoredRole();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function clearFields() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;

    setError("");
    setSuccess("");

    if (!currentPassword) { setError("Current password is required."); return; }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }

    const token = getStoredToken();
    if (!token) { setError("Your session has expired. Please log in again."); return; }

    setLoading(true);
    try {
      const res = await fetch("/api/admin/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmNewPassword: confirmPassword,
        }),
      });

      const data = await res.json();

      if (!data.success) {
        setError(data.message || "Unable to change password.");
        return;
      }

      // The change invalidated older sessions; keep this one signed in.
      if (typeof data.token === "string") {
        localStorage.setItem("msu-token", data.token);
      }

      clearFields();
      setSuccess(
        data.message ||
          "Password changed successfully. Other signed-in sessions have been signed out."
      );
    } catch {
      setError("Unable to connect to server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (role === "super_admin") {
    return (
      <div className={styles.page}>
        <Card className={styles.section}>
          <div className={styles.noticeBlock}>
            <div className={styles.noticeIcon}>
              <ShieldCheck />
            </div>
            <h2>Managed outside the portal</h2>
            <p>
              Super Admin passwords are stored as bcrypt one-way hashes and can
              never be decrypted or displayed, so they are not changed from this
              page. A Super Admin credential is set with the server-side
              maintenance script.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Card className={styles.section}>
        <CardHeader
          title="Change Password"
          subtitle="Update the password you use to sign in to the admin portal"
        />

        <div className={styles.notice}>
          <Lock size={16} />
          <span>
            Your password is stored with reversible AES-256-GCM encryption, so a
            Super Admin can recover the current value when required. Changing it
            here replaces that value everywhere — recovery will return the new
            password.
          </span>
        </div>

        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="current-password">Current Password *</label>
              <input
                id="current-password"
                type="password"
                placeholder="Enter your current password"
                value={currentPassword}
                onChange={(e) => { setCurrentPassword(e.target.value); setError(""); setSuccess(""); }}
                autoComplete="current-password"
                autoFocus
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="new-password">New Password *</label>
              <input
                id="new-password"
                type="password"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(""); setSuccess(""); }}
                autoComplete="new-password"
              />
            </div>

            <div className={styles.formField}>
              <label htmlFor="confirm-password">Confirm New Password *</label>
              <input
                id="confirm-password"
                type="password"
                placeholder="Re-enter the new password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(""); setSuccess(""); }}
                autoComplete="new-password"
              />
            </div>
          </div>

          {error && (
            <p className={styles.formError}>
              <AlertTriangle size={14} /> {error}
            </p>
          )}
          {success && (
            <p className={styles.formSuccess}>
              <Check size={14} /> {success}
            </p>
          )}

          <div className={styles.formActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => { clearFields(); setError(""); setSuccess(""); }}
              disabled={loading}
            >
              Clear
            </Button>
            <Button type="submit" variant="primary" loading={loading}>
              <KeyRound size={15} /> Change Password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
