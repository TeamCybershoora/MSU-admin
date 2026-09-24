"use client";

/**
 * Admin Login Page — standalone authentication page for administrators.
 *
 * Unlike the student two-step sign-in flow, admin login is a single-step
 * email + password form. On success, the JWT and admin info are stored in
 * localStorage and the user is redirected to /admin.
 *
 * Data flow:
 *   1. Form submits email + password to POST /api/admin/login
 *   2. Server verifies credentials against the Admin collection (bcrypt)
 *   3. On success, stores token and user JSON in localStorage
 *   4. Redirects to /admin dashboard
 *
 * Security:
 * - Generic error message ("Invalid email or password.") prevents
 *   account enumeration — same message for wrong email and wrong password.
 * - Rate-limited server-side (10 attempts / 15 min per IP).
 * - If already authenticated with a non-student token, redirects to /admin.
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken, clearAuthSession)
 *   - POST /api/admin/login (server-side route)
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { GraduationCap, Lock, Mail, ArrowRight, Shield } from "lucide-react";
import { getStoredToken, clearAuthSession } from "@/lib/auth";
import styles from "./page.module.css";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Redirect if already authenticated
  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.role !== "student") {
          router.push("/admin");
        }
      } catch {
        clearAuthSession();
      }
    }
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Email is required.");
      return;
    }
    if (!password) {
      setError("Password is required.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });

      const data = await res.json();

      if (!data.success || !data.token) {
        setError(data.message || "Login failed. Please try again.");
        setLoading(false);
        return;
      }

      // Store admin token
      localStorage.setItem("msu-token", data.token);
      localStorage.setItem(
        "msu-user",
        JSON.stringify({
          name: data.admin.name,
          email: data.admin.email,
          role: data.admin.role,
          accountType: "admin" as const,
          signedInAt: Date.now(),
        })
      );

      router.push("/admin");
    } catch {
      setError("Unable to connect to server. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.iconWrap}>
            <GraduationCap />
          </div>
          <h1>Admin Portal</h1>
          <p>
            <Shield size={14} /> Secure administrator access
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          <div className={styles.field}>
            <label htmlFor="admin-email">
              <Mail size={14} /> Email Address
            </label>
            <div className={styles.input}>
              <Mail />
              <input
                id="admin-email"
                type="email"
                placeholder="admin@msu.ac.in"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                }}
                autoComplete="email"
                required
              />
            </div>
          </div>

          <div className={styles.field}>
            <label htmlFor="admin-password">
              <Lock size={14} /> Password
            </label>
            <div className={styles.input}>
              <Lock />
              <input
                id="admin-password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError("");
                }}
                autoComplete="current-password"
                required
              />
            </div>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className={styles.spinner} aria-hidden="true" />
                Signing in...
              </>
            ) : (
              <>
                <ArrowRight size={18} />
                Sign In
              </>
            )}
          </button>
        </form>

        <div className={styles.footer}>
          <p>MSU Administration System</p>
        </div>
      </div>
    </div>
  );
}
