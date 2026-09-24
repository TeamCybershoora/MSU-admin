"use client";

/**
 * Admin Dashboard Page — landing page after login.
 *
 * Displays aggregate statistics (student count, results, syllabus, colleges)
 * fetched from GET /api/admin/dashboard with the stored JWT.
 *
 * Data flow:
 *   1. Reads JWT from localStorage via getStoredToken()
 *   2. Calls /api/admin/dashboard with Bearer token
 *   3. Server queries MongoDB collection counts in parallel
 *   4. Stats are rendered in StatCard components
 *
 * Dependencies:
 *   - @/lib/auth (getStoredToken)
 *   - @/components/ui/card (Card, CardHeader, StatCard)
 *   - @/components/error-state (ErrorState)
 *
 * Note: Some stats (faculty, pendingApplications, upcomingExams) are
 * placeholder nulls — no data source exists yet.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Users,
  FileText,
  BookOpen,
  ClipboardList,
  ArrowRight,
  GraduationCap,
  Building2,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader, StatCard } from "@/components/ui/card";
import ErrorState from "@/components/error-state";
import styles from "./page.module.css";

interface DashboardStats {
  totalStudents: number;
  totalResults: number;
  totalSyllabi: number;
  totalFaculty: number | null;
  pendingApplications: number | null;
  upcomingExams: number | null;
}

const QUICK_ACTIONS = [
  { href: "/admin/students", label: "Manage Students", icon: Users, description: "View and manage student accounts" },
  { href: "/admin/results", label: "Manage Results", icon: FileText, description: "Upload and manage result records" },
  { href: "/admin/syllabus", label: "Manage Syllabus", icon: BookOpen, description: "Upload syllabus and documents" },
  { href: "/admin/colleges", label: "Manage Colleges", icon: Building2, description: "Manage affiliated colleges and PDF" },
];

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      const token = getStoredToken();
      if (!token) return;

      try {
        const res = await fetch("/api/admin/dashboard", {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          if (!cancelled) setError("Unable to load dashboard statistics.");
          return;
        }

        const data = await res.json();
        if (!cancelled && data.success) {
          setStats(data.data);
        }
      } catch {
        if (!cancelled) setError("Unable to connect to server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStats();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={styles.page}>
      {/* Welcome Banner */}
      <div className={styles.welcome}>
        <div className={styles.welcomeText}>
          <h2>Admin Dashboard</h2>
          <p>Welcome to the MSU Administration Portal. Manage students, results, and academic documents.</p>
        </div>
        <div className={styles.welcomeIcon}>
          <GraduationCap />
        </div>
      </div>

      {/* Stats Grid */}
      <div className={styles.statsGrid}>
        {loading ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className={styles.statSkeleton}>
                <div className={styles.skeletonPulse} />
              </Card>
            ))}
          </>
        ) : error ? (
          <Card className={styles.errorCard}>
            <ErrorState
              title="Unable to load statistics"
              description={error}
              onRetry={() => {
                setError("");
                setLoading(true);
                window.location.reload();
              }}
            />
          </Card>
        ) : (
          <>
            <StatCard
              label="Total Students"
              value={stats?.totalStudents ?? 0}
              icon={<Users />}
              variant="teal"
            />
            <StatCard
              label="Total Results"
              value={stats?.totalResults ?? 0}
              icon={<FileText />}
              variant="accent"
            />
            <StatCard
              label="Syllabus Records"
              value={stats?.totalSyllabi ?? 0}
              icon={<BookOpen />}
              variant="muted"
            />
            <StatCard
              label="Faculty/Staff"
              value="N/A"
              icon={<ClipboardList />}
              variant="neutral"
            />
          </>
        )}
      </div>

      {/* Quick Actions */}
      <Card className={styles.section}>
        <CardHeader title="Quick Actions" subtitle="Common administrative tasks" />
        <div className={styles.actionsGrid}>
          {QUICK_ACTIONS.map((action) => (
            <Link key={action.href} href={action.href} className={styles.actionCard}>
              <div className={styles.actionIcon}>
                <action.icon />
              </div>
              <div className={styles.actionContent}>
                <span className={styles.actionLabel}>{action.label}</span>
                <span className={styles.actionDesc}>{action.description}</span>
              </div>
              <ArrowRight size={16} className={styles.actionArrow} />
            </Link>
          ))}
        </div>
      </Card>

      {/* System Info */}
      <Card className={styles.section}>
        <CardHeader title="System Information" subtitle="Current system status" />
        <div className={styles.infoList}>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Students in Database</span>
            <span className={styles.infoValue}>{stats?.totalStudents ?? "—"}</span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Result Records</span>
            <span className={styles.infoValue}>{stats?.totalResults ?? "—"}</span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Syllabus Documents</span>
            <span className={styles.infoValue}>{stats?.totalSyllabi ?? "—"}</span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Faculty Data</span>
            <span className={styles.infoValue}>
              <span className={styles.unavailable}>Not available yet</span>
            </span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Exam Data</span>
            <span className={styles.infoValue}>
              <span className={styles.unavailable}>Not available yet</span>
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
