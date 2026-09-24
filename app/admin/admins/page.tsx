"use client";

/**
 * Admin Management Page — Super Admin only.
 *
 * Features:
 * - Admin list (name, email, role, status, password storage scheme, last login)
 * - Create a normal admin (with an optional server-generated password)
 * - Activate / deactivate a normal admin
 * - Reset a normal admin password (with an optional server-generated password)
 * - View Current Password of a normal admin (explicit, per-account action)
 *
 * Data flow:
 *   1. GET  /api/admin/admins                  — list accounts (never passwords)
 *   2. POST /api/admin/admins                  — create a normal admin
 *   3. PATCH /api/admin/admins/{id}            — activate / deactivate
 *   4. POST /api/admin/admins/{id}/password    — reset password
 *   5. POST /api/admin/admins/{id}/reveal      — recover password (confirm: true)
 *
 * Security:
 * - The role decoded from the JWT is used ONLY to decide what to render. Every
 *   endpoint independently enforces super_admin server-side, so a normal admin
 *   who renders this page still gets 403 from the API.
 * - Passwords are never preloaded: they are fetched one account at a time, only
 *   after an explicit Reveal click, and are cleared from component state as
 *   soon as the dialog closes.
 * - Generated passwords are displayed once, with a warning to store them safely.
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/components/ui/* (Card, CardHeader, Button, Badge, Modal, ConfirmDialog)
 */

import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck,
  Users,
  KeyRound,
  Eye,
  RefreshCw,
  UserPlus,
  Power,
  Copy,
  AlertTriangle,
  Lock,
  Check,
} from "lucide-react";
import { getStoredRole, getStoredToken, useStoredRole } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import Modal, { ConfirmDialog } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

interface AdminAccount {
  id: string;
  name: string;
  email: string;
  role: "admin" | "super_admin";
  status: "active" | "inactive";
  passwordScheme: "aes-256-gcm" | "bcrypt";
  canRevealPassword: boolean;
  lastLogin: string | null;
  createdAt: string | null;
  isSelf: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export default function AdminManagementPage() {
  const role = useStoredRole();
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* ── Create ─────────────────────────────────────────── */
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createGenerate, setCreateGenerate] = useState(true);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdCredentials, setCreatedCredentials] = useState<{
    email: string;
    password: string;
  } | null>(null);

  /* ── Reset ──────────────────────────────────────────── */
  const [resetTarget, setResetTarget] = useState<AdminAccount | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetGenerate, setResetGenerate] = useState(true);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetResult, setResetResult] = useState<string | null>(null);

  /* ── Reveal ─────────────────────────────────────────── */
  const [revealTarget, setRevealTarget] = useState<AdminAccount | null>(null);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState(false);
  const [revealError, setRevealError] = useState("");
  const [copied, setCopied] = useState("");

  /* ── Status toggle ──────────────────────────────────── */
  const [statusTarget, setStatusTarget] = useState<AdminAccount | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const fetchAdmins = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setError("Your session has expired. Please log in again.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/admins", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (res.status === 403) {
        setError("Only Super Admins can manage admin accounts.");
        return;
      }
      if (!res.ok) {
        setError("Unable to load admin accounts.");
        return;
      }

      const data = await res.json();
      if (data.success) setAdmins(data.data as AdminAccount[]);
    } catch {
      setError("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (getStoredRole() === "super_admin") fetchAdmins();
    else setLoading(false);
  }, [fetchAdmins]);

  async function copyToClipboard(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      /* Clipboard unavailable — the value stays visible for manual copy. */
    }
  }

  /* ── Create handlers ───────────────────────────────── */

  function openCreate() {
    setCreateName("");
    setCreateEmail("");
    setCreatePassword("");
    setCreateGenerate(true);
    setCreateError("");
    setCreatedCredentials(null);
    setShowCreate(true);
  }

  function closeCreate() {
    if (createLoading) return;
    setShowCreate(false);
    setCreateError("");
    // Never keep a generated credential in state after the dialog closes.
    setCreatedCredentials(null);
    setCreatePassword("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (createLoading) return;

    if (!createName.trim()) { setCreateError("Admin name is required."); return; }
    if (!createEmail.trim()) { setCreateError("Email is required."); return; }
    if (!createGenerate && createPassword.length < 8) {
      setCreateError("Password must be at least 8 characters.");
      return;
    }

    const token = getStoredToken();
    if (!token) return;

    setCreateLoading(true);
    setCreateError("");
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: createName.trim(),
          email: createEmail.trim(),
          password: createGenerate ? undefined : createPassword,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        setCreateError(data.message || "Failed to create admin.");
        return;
      }

      setCreatePassword("");
      if (data.generatedPassword) {
        setCreatedCredentials({
          email: data.admin.email,
          password: data.generatedPassword,
        });
      } else {
        setShowCreate(false);
      }
      fetchAdmins();
    } catch {
      setCreateError("Unable to connect to server.");
    } finally {
      setCreateLoading(false);
    }
  }

  /* ── Reset handlers ────────────────────────────────── */

  function openReset(admin: AdminAccount) {
    setResetTarget(admin);
    setResetPassword("");
    setResetGenerate(true);
    setResetError("");
    setResetResult(null);
  }

  function closeReset() {
    if (resetLoading) return;
    setResetTarget(null);
    setResetError("");
    setResetResult(null);
    setResetPassword("");
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (!resetTarget || resetLoading) return;

    if (!resetGenerate && resetPassword.length < 8) {
      setResetError("Password must be at least 8 characters.");
      return;
    }

    const token = getStoredToken();
    if (!token) return;

    setResetLoading(true);
    setResetError("");
    try {
      const res = await fetch(`/api/admin/admins/${resetTarget.id}/password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          password: resetGenerate ? undefined : resetPassword,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        setResetError(data.message || "Failed to reset password.");
        return;
      }

      setResetPassword("");
      if (data.generatedPassword) {
        setResetResult(data.generatedPassword);
      } else {
        // A password the Super Admin typed is never echoed back.
        setResetTarget(null);
      }
      fetchAdmins();
    } catch {
      setResetError("Unable to connect to server.");
    } finally {
      setResetLoading(false);
    }
  }

  /* ── Reveal handlers ───────────────────────────────── */

  function openReveal(admin: AdminAccount) {
    setRevealTarget(admin);
    setRevealedPassword(null);
    setRevealError("");
  }

  function closeReveal() {
    if (revealLoading) return;
    setRevealTarget(null);
    setRevealedPassword(null);
    setRevealError("");
  }

  async function handleReveal() {
    if (!revealTarget || revealLoading) return;

    const token = getStoredToken();
    if (!token) return;

    setRevealLoading(true);
    setRevealError("");
    try {
      const res = await fetch(`/api/admin/admins/${revealTarget.id}/reveal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // Explicit user action, re-affirmed to the server.
        body: JSON.stringify({ confirm: true }),
      });

      const data = await res.json();
      if (!data.success) {
        setRevealError(data.message || "Unable to recover password.");
        return;
      }

      setRevealedPassword(data.data.password as string);
    } catch {
      setRevealError("Unable to connect to server.");
    } finally {
      setRevealLoading(false);
    }
  }

  /* ── Status handlers ───────────────────────────────── */

  async function handleStatusToggle() {
    if (!statusTarget || statusLoading) return;

    const token = getStoredToken();
    if (!token) return;

    const nextStatus = statusTarget.status === "active" ? "inactive" : "active";

    setStatusLoading(true);
    try {
      const res = await fetch(`/api/admin/admins/${statusTarget.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: nextStatus }),
      });

      const data = await res.json();
      if (data.success) fetchAdmins();
      else setError(data.message || "Unable to update admin status.");
    } catch {
      setError("Unable to connect to server.");
    } finally {
      setStatusLoading(false);
      setStatusTarget(null);
    }
  }

  /* ── Access gate (presentation only) ───────────────── */

  if (role && role !== "super_admin") {
    return (
      <div className={styles.page}>
        <Card className={styles.section}>
          <div className={styles.restricted}>
            <div className={styles.restrictedIcon}>
              <Lock />
            </div>
            <h2>Super Admin access required</h2>
            <p>
              Admin account management is restricted to Super Administrators.
              Contact a Super Admin if you need an account created or reset.
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
          title="Admin Management"
          subtitle="Create accounts, control access, and manage credentials"
          actions={
            <div className={styles.headerActions}>
              <Button variant="secondary" size="sm" onClick={fetchAdmins} loading={loading}>
                <RefreshCw size={14} /> Refresh
              </Button>
              <Button variant="primary" size="sm" onClick={openCreate}>
                <UserPlus size={14} /> Create Admin
              </Button>
            </div>
          }
        />

        <div className={styles.notice}>
          <ShieldCheck size={16} />
          <span>
            Normal admin passwords are stored with reversible AES-256-GCM
            encryption so they can be recovered here. Super Admin passwords are
            bcrypt-hashed and can never be recovered.
          </span>
        </div>

        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading admin accounts...</p>
          </div>
        ) : error ? (
          <ErrorState
            title="Unable to load admin accounts"
            description={error}
            onRetry={fetchAdmins}
          />
        ) : admins.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="No admin accounts"
            description="Create the first admin account to get started."
          />
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Password Storage</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {admins.map((admin) => (
                  <tr key={admin.id}>
                    <td className={styles.nameCell}>
                      {admin.name}
                      {admin.isSelf && <span className={styles.selfTag}>You</span>}
                    </td>
                    <td className={styles.emailCell}>{admin.email}</td>
                    <td>
                      <Badge variant={admin.role === "super_admin" ? "warning" : "info"}>
                        {admin.role === "super_admin" ? "Super Admin" : "Admin"}
                      </Badge>
                    </td>
                    <td>
                      <Badge variant={admin.status === "active" ? "success" : "neutral"}>
                        {admin.status === "active" ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td>
                      <Badge
                        variant={admin.canRevealPassword ? "success" : "neutral"}
                      >
                        {admin.passwordScheme === "aes-256-gcm" ? "AES-256-GCM" : "bcrypt"}
                      </Badge>
                    </td>
                    <td className={styles.monoCell}>{formatDate(admin.lastLogin)}</td>
                    <td>
                      <div className={styles.actionsCell}>
                        {admin.role === "super_admin" ? (
                          <span className={styles.protectedNote}>
                            <Lock size={12} /> Protected
                          </span>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openReveal(admin)}
                              disabled={!admin.canRevealPassword}
                              title={
                                admin.canRevealPassword
                                  ? "View current password"
                                  : "Legacy bcrypt hash — reset the password to enable recovery"
                              }
                            >
                              <Eye size={15} /> View Password
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openReset(admin)}
                              title="Reset password"
                            >
                              <KeyRound size={15} /> Reset
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setStatusTarget(admin)}
                              title={admin.status === "active" ? "Deactivate" : "Activate"}
                            >
                              <Power size={15} />
                              {admin.status === "active" ? "Deactivate" : "Activate"}
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Create Admin ─────────────────────────────── */}
      <Modal open={showCreate} onClose={closeCreate}>
        {createdCredentials ? (
          <div>
            <h3 className={styles.modalTitle}>Admin created</h3>
            <p className={styles.modalDesc}>
              Copy this password now — it is shown only once and cannot be
              retrieved from this dialog again.
            </p>
            <div className={styles.sensitiveBox}>
              <div className={styles.sensitiveRow}>
                <span className={styles.sensitiveLabel}>Email</span>
                <span className={styles.monoValue}>{createdCredentials.email}</span>
              </div>
              <div className={styles.sensitiveRow}>
                <span className={styles.sensitiveLabel}>Password</span>
                <span className={styles.monoValue}>{createdCredentials.password}</span>
              </div>
            </div>
            <p className={styles.warningNote}>
              <AlertTriangle size={14} />
              Sensitive credential information. Do not share it over insecure
              channels.
            </p>
            <div className={styles.modalActions}>
              <Button
                variant="secondary"
                onClick={() =>
                  copyToClipboard(
                    `Email: ${createdCredentials.email}\nPassword: ${createdCredentials.password}`,
                    "create"
                  )
                }
              >
                {copied === "create" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "create" ? "Copied" : "Copy"}
              </Button>
              <Button variant="primary" onClick={closeCreate}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleCreate}>
            <h3 className={styles.modalTitle}>Create Admin</h3>
            <p className={styles.modalDesc}>
              Creates a normal admin. The password is stored with reversible
              AES-256-GCM encryption.
            </p>
            <div className={styles.formFields}>
              <div className={styles.formField}>
                <label htmlFor="new-admin-name">Full Name *</label>
                <input
                  id="new-admin-name"
                  type="text"
                  placeholder="e.g. Priya Sharma"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="new-admin-email">Email Address *</label>
                <input
                  id="new-admin-email"
                  type="email"
                  placeholder="admin@msu.ac.in"
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                />
              </div>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={createGenerate}
                  onChange={(e) => setCreateGenerate(e.target.checked)}
                />
                Generate a secure password on the server
              </label>
              {!createGenerate && (
                <div className={styles.formField}>
                  <label htmlFor="new-admin-password">Password *</label>
                  <input
                    id="new-admin-password"
                    type="text"
                    placeholder="At least 8 characters"
                    value={createPassword}
                    onChange={(e) => setCreatePassword(e.target.value)}
                  />
                  <span className={styles.hint}>
                    The password is not shown again after creation unless you
                    reveal it from the admin list.
                  </span>
                </div>
              )}
            </div>
            {createError && <p className={styles.formError}>{createError}</p>}
            <div className={styles.modalActions}>
              <Button type="button" variant="secondary" onClick={closeCreate} disabled={createLoading}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={createLoading}>
                Create Admin
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Reset Password ───────────────────────────── */}
      <Modal open={!!resetTarget} onClose={closeReset}>
        {resetResult ? (
          <div>
            <h3 className={styles.modalTitle}>Password reset</h3>
            <p className={styles.modalDesc}>
              Copy this password now — it is shown only once. The admin&apos;s
              existing sessions have been invalidated.
            </p>
            <div className={styles.sensitiveBox}>
              <div className={styles.sensitiveRow}>
                <span className={styles.sensitiveLabel}>Account</span>
                <span className={styles.monoValue}>{resetTarget?.email}</span>
              </div>
              <div className={styles.sensitiveRow}>
                <span className={styles.sensitiveLabel}>New password</span>
                <span className={styles.monoValue}>{resetResult}</span>
              </div>
            </div>
            <p className={styles.warningNote}>
              <AlertTriangle size={14} />
              Sensitive credential information. Share it with the admin through a
              secure channel.
            </p>
            <div className={styles.modalActions}>
              <Button
                variant="secondary"
                onClick={() => copyToClipboard(resetResult, "reset")}
              >
                {copied === "reset" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "reset" ? "Copied" : "Copy"}
              </Button>
              <Button variant="primary" onClick={closeReset}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleReset}>
            <h3 className={styles.modalTitle}>Reset Password</h3>
            <p className={styles.modalDesc}>
              Set a new password for <strong>{resetTarget?.name}</strong> (
              {resetTarget?.email}). Encrypted with AES-256-GCM and recoverable
              by Super Admins.
            </p>
            <div className={styles.formFields}>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={resetGenerate}
                  onChange={(e) => setResetGenerate(e.target.checked)}
                />
                Generate a secure password on the server
              </label>
              {!resetGenerate && (
                <div className={styles.formField}>
                  <label htmlFor="reset-admin-password">New Password *</label>
                  <input
                    id="reset-admin-password"
                    type="text"
                    placeholder="At least 8 characters"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                  />
                </div>
              )}
            </div>
            {resetError && <p className={styles.formError}>{resetError}</p>}
            <div className={styles.modalActions}>
              <Button type="button" variant="secondary" onClick={closeReset} disabled={resetLoading}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={resetLoading}>
                Reset Password
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Reveal Password ──────────────────────────── */}
      <Modal open={!!revealTarget} onClose={closeReveal}>
        <div>
          <h3 className={styles.modalTitle}>View Current Password</h3>
          <p className={styles.modalDesc}>
            Recover the currently stored password for{" "}
            <strong>{revealTarget?.name}</strong> ({revealTarget?.email}). This is
            always the account&apos;s latest password — including one the admin
            changed themselves.
          </p>

          <p className={styles.warningNote}>
            <AlertTriangle size={14} />
            Sensitive credential information. Revealing a password is logged
            only as an action (never its value) and is limited to 10 requests per
            15 minutes. Make sure nobody can see your screen.
          </p>

          {revealedPassword ? (
            <>
              <div className={styles.sensitiveBox}>
                <div className={styles.sensitiveRow}>
                  <span className={styles.sensitiveLabel}>Current password</span>
                  <span className={styles.monoValue}>{revealedPassword}</span>
                </div>
              </div>
              <div className={styles.modalActions}>
                <Button
                  variant="secondary"
                  onClick={() => copyToClipboard(revealedPassword, "reveal")}
                >
                  {copied === "reveal" ? <Check size={14} /> : <Copy size={14} />}
                  {copied === "reveal" ? "Copied" : "Copy"}
                </Button>
                <Button variant="primary" onClick={closeReveal}>Close</Button>
              </div>
            </>
          ) : (
            <>
              {revealError && <p className={styles.formError}>{revealError}</p>}
              <div className={styles.modalActions}>
                <Button variant="secondary" onClick={closeReveal} disabled={revealLoading}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={handleReveal} loading={revealLoading}>
                  <Eye size={14} /> View Current Password
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!statusTarget}
        onClose={() => { if (!statusLoading) setStatusTarget(null); }}
        onConfirm={handleStatusToggle}
        title={statusTarget?.status === "active" ? "Deactivate Admin" : "Activate Admin"}
        description={
          statusTarget?.status === "active"
            ? `"${statusTarget?.name}" will no longer be able to log in to the admin portal.`
            : `"${statusTarget?.name}" will regain access to the admin portal.`
        }
        confirmLabel={statusTarget?.status === "active" ? "Deactivate" : "Activate"}
        variant={statusTarget?.status === "active" ? "danger" : "info"}
        loading={statusLoading}
      />
    </div>
  );
}
