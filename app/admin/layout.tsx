"use client";

/**
 * Admin Layout — shared shell for every /admin/* page.
 *
 * Provides:
 * - Sidebar navigation (responsive: drawer on mobile, fixed on desktop)
 * - Header with page title and "View Site" link
 * - Content area where child pages render
 * - Logout functionality
 *
 * Security:
 * - On mount, validates the stored JWT by calling GET /api/admin/dashboard.
 *   If the token is missing, expired, or the admin is inactive, the user
 *   is redirected to /admin/login. This check runs on every route change
 *   because the component remounts when the pathname changes.
 * - The JWT payload is decoded client-side ONLY for display purposes
 *   (name, email, role in the sidebar). Authorization decisions are always
 *   made server-side by the authenticateAdmin() helper in each API route.
 *
 * Dependencies:
 * - @/lib/auth — getStoredToken(), clearAuthSession()
 * - @/lib/admin-auth (server) — authenticateAdmin() used by API routes
 * - lucide-react — sidebar and header icons
 *
 * DO NOT: Remove the auth check or trust client-decoded roles for access control.
 */

import { useState, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Users,
  FileText,
  BookOpen,
  LogOut,
  GraduationCap,
  Menu,
  X,
  Shield,
  ShieldCheck,
  KeyRound,
  Building2,
  Megaphone,
  Inbox,
  ChevronRight,
  Mail,
  Layers,
  MessageSquare,
  Newspaper,
  Camera,
  Crown,
  Briefcase,
  Gauge,
  Bell,
  Radio,
  ChevronDown,
} from "lucide-react";
import { getStoredToken, clearAuthSession } from "@/lib/auth";
import { useDismiss } from "@/components/dashboard/hooks";
import type { DashboardApiStats } from "@/components/dashboard";
import styles from "./layout.module.css";

interface AdminInfo {
  name: string;
  email: string;
  role: string;
}

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/students", label: "Student Management", icon: Users },
  //
  // Master academic data (programme → session → semester → subject). It sits
  // directly above Result and Syllabus because those modules read this
  // definition of what is taught; this page only manages the definition.
  //
  {
    href: "/admin/academic-structure",
    label: "Academic Structure",
    icon: Layers,
  },
  { href: "/admin/results", label: "Result Management", icon: FileText },
  { href: "/admin/notices", label: "Notices Management", icon: Megaphone },
  { href: "/admin/news", label: "News Management", icon: Newspaper },
  { href: "/admin/spotlight", label: "Spotlight Management", icon: Camera },
  { href: "/admin/announcements", label: "Announcement Bar Management", icon: Radio },
  { href: "/admin/leadership", label: "Leadership Management", icon: Crown },
  { href: "/admin/recruitment", label: "Recruitment Management", icon: Briefcase },
  { href: "/admin/syllabus", label: "Syllabus & Documents", icon: BookOpen },
  { href: "/admin/colleges", label: "College Management", icon: Building2 },
];

//
// Enquiry Management — the ONE sidebar entry for enquiries, expanding to the
// two type-scoped pages below. There is no page at the group href itself:
// each child route lists only its own enquiry type (the type filter is always
// sent to the API and validated server-side).
//
const ENQUIRY_NAV_GROUP = {
  href: "/admin/enquiries",
  label: "Enquiry Management",
  icon: Inbox,
  children: [
    {
      href: "/admin/enquiries/admission",
      label: "Admission Enquiries",
      icon: GraduationCap,
    },
    {
      href: "/admin/enquiries/college-registration",
      label: "College Registration Enquiries",
      icon: Building2,
    },
    {
      href: "/admin/enquiries/general",
      label: "General Enquiries",
      icon: MessageSquare,
    },
    {
      href: "/admin/enquiries/automated-email",
      label: "Automated Email",
      icon: Mail,
    },
  ],
};

function isActivePath(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

//
// Acknowledgement-email settings now live inside the Enquiry Management group
// (see ENQUIRY_NAV_GROUP.children above), reached at
// /admin/enquiries/automated-email. The API re-checks authentication on each
// request, and template writes follow the same auth rules as the rest of the
// admin API.
//

//
// Rendered only for Super Admins. This is presentation only — every
// admin-management endpoint re-checks role === "super_admin" server-side.
//
const SUPER_ADMIN_NAV_ITEM = {
  href: "/admin/admins",
  label: "Admin Management",
  icon: ShieldCheck,
};

//
// The Super Admin dashboard (/admin/super-admin), hosting the Overview and
// Insights screens. Rendered only for Super Admins — again presentation only.
//
const SUPER_ADMIN_DASHBOARD_NAV_ITEM = {
  href: "/admin/super-admin",
  label: "Super Admin",
  icon: Gauge,
};

//
// Self-service password change, shown to normal admins. Super Admin passwords
// are bcrypt-hashed and remain out of scope (see app/api/admin/change-password).
//
const CHANGE_PASSWORD_NAV_ITEM = {
  href: "/admin/change-password",
  label: "Change Password",
  icon: KeyRound,
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [admin, setAdmin] = useState<AdminInfo | null>(null);
  const [checking, setChecking] = useState(true);

  //
  // Top-bar surfaces. Only one dropdown is open at a time; both close on
  // outside click / Escape (useDismiss) and on route change below.
  //
  const [openMenu, setOpenMenu] = useState<"profile" | "notifications" | null>(null);
  //
  // Notification counts are REAL dashboard totals, fetched lazily the first
  // time the panel is opened. Nothing is fetched (and no badge is faked)
  // before that, so the shell stays cheap on every admin page.
  //
  const [notifications, setNotifications] = useState<DashboardApiStats | null>(null);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifyError, setNotifyError] = useState(false);

  const profileRef = useDismiss<HTMLDivElement>(openMenu === "profile", () =>
    setOpenMenu(null)
  );
  const notifyRef = useDismiss<HTMLDivElement>(openMenu === "notifications", () =>
    setOpenMenu(null)
  );
  // Enquiry group open/closed. Starts open when landing directly on one of its
  // pages; navigating into the group from anywhere expands it (see the
  // lastPathname adjustment below); the admin can still toggle it manually.
  const [enquiryGroupOpen, setEnquiryGroupOpen] = useState(
    () => !!pathname && isActivePath(ENQUIRY_NAV_GROUP.href, pathname)
  );

  const isLoginPage = pathname === "/admin/login";

  const checkAuth = useCallback(async () => {
    if (isLoginPage) {
      setChecking(false);
      return;
    }

    const token = getStoredToken();
    if (!token) {
      router.push("/admin/login");
      return;
    }

    try {
      const res = await fetch("/api/admin/dashboard", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        clearAuthSession();
        router.push("/admin/login");
        return;
      }

      const payload = JSON.parse(atob(token.split(".")[1]));
      setAdmin({
        name: payload.name || "Administrator",
        email: payload.email || "",
        role: payload.role || "admin",
      });
    } catch {
      clearAuthSession();
      router.push("/admin/login");
    } finally {
      setChecking(false);
    }
  }, [isLoginPage, router]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { checkAuth(); }, [checkAuth]);

  // The mobile drawer is a modal surface: lock page scrolling behind it and
  // restore the previous inline value when it closes (inline styles only —
  // the stylesheet's own overflow rules are untouched).
  // The drawer can only be opened from the mobile menu button, but if the
  // viewport crosses back to the desktop layout while it is open (rotate /
  // resize), clear the open state so neither the lock nor a stale flag
  // survives. setState runs in the matchMedia callback (a subscription),
  // never synchronously in the effect body.
  useEffect(() => {
    if (!sidebarOpen) return;

    const desktop = window.matchMedia("(min-width: 901px)");
    const handleViewportChange = () => {
      if (desktop.matches) setSidebarOpen(false);
    };
    desktop.addEventListener("change", handleViewportChange);

    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    return () => {
      desktop.removeEventListener("change", handleViewportChange);
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [sidebarOpen]);

  // Close the mobile drawer whenever the route changes. Adjusted during render
  // (React's "Adjusting some state when a prop changes") rather than in an
  // effect, so the drawer is already closed in the same pass instead of one
  // render later. Converges immediately, since pathname only changes on
  // navigation.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setSidebarOpen(false);
    setOpenMenu(null);
    if (isActivePath(ENQUIRY_NAV_GROUP.href, pathname)) {
      setEnquiryGroupOpen(true);
    }
  }

  if (isLoginPage) {
    return <>{children}</>;
  }

  if (checking) {
    return (
      <div className={styles.adminPage}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minHeight: "100vh",
        }}>
          <div style={{
            width: "2.5rem",
            height: "2.5rem",
            borderRadius: "50%",
            border: "4px solid var(--border)",
            borderTop: "4px solid var(--muted)",
            animation: "spin 0.8s linear infinite",
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  function handleLogout() {
    clearAuthSession();
    router.push("/admin/login");
  }

  /**
   * Open/close the notification panel, loading the real counts on first open.
   * The fetch lives in this event handler (not an effect) so no state is set
   * synchronously during a render pass.
   */
  function toggleNotifications() {
    const next = openMenu === "notifications" ? null : "notifications";
    setOpenMenu(next);
    if (next && !notifications && !notifyLoading) void loadNotifications();
  }

  async function loadNotifications() {
    const token = getStoredToken();
    if (!token) return;
    setNotifyLoading(true);
    setNotifyError(false);
    try {
      const res = await fetch("/api/admin/dashboard", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setNotifyError(true);
        return;
      }
      const data = await res.json();
      if (data?.success) setNotifications(data.data as DashboardApiStats);
      else setNotifyError(true);
    } catch {
      setNotifyError(true);
    } finally {
      setNotifyLoading(false);
    }
  }

  function toggleProfile() {
    setOpenMenu(openMenu === "profile" ? null : "profile");
  }

  const initials = admin
    ? admin.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "AD";

  const extraNavItems =
    admin?.role === "super_admin"
      ? [SUPER_ADMIN_DASHBOARD_NAV_ITEM, SUPER_ADMIN_NAV_ITEM]
      : [CHANGE_PASSWORD_NAV_ITEM];
  const navItems = [...NAV_ITEMS, ...extraNavItems];

  //
  // Notification items are derived ONLY from real enquiry counts. When nothing
  // is outstanding the panel says so rather than showing a fabricated alert.
  //
  const newEnquiries = notifications?.enquiriesByStatus?.new ?? 0;
  const inReviewEnquiries = notifications?.enquiriesByStatus?.in_review ?? 0;
  const notifyItems = [
    newEnquiries > 0
      ? {
          label: `new ${newEnquiries === 1 ? "enquiry" : "enquiries"} awaiting review`,
          count: newEnquiries,
          href: "/admin/enquiries/admission",
        }
      : null,
    inReviewEnquiries > 0
      ? {
          label: "enquiries currently in review",
          count: inReviewEnquiries,
          href: "/admin/enquiries/admission",
        }
      : null,
  ].filter((item): item is { label: string; count: number; href: string } => item !== null);
  const notifyCount = newEnquiries + inReviewEnquiries;

  // Most specific match first: a child page's title beats the group, an exact
  // href beats a prefix match (the Dashboard href matches every /admin path,
  // so a plain prefix search would label every page "Dashboard").
  const enquiryChildItem = ENQUIRY_NAV_GROUP.children.find((child) =>
    isActivePath(child.href, pathname)
  );
  const currentItem =
    enquiryChildItem ??
    navItems.find((item) => item.href === pathname) ??
    navItems.find((item) => isActivePath(item.href, pathname));
  const pageTitle = currentItem?.label || "Admin Portal";

  return (
    <div className={styles.adminPage}>
      {sidebarOpen && (
        <div
          className={styles.overlay}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`}>
        <div className={styles.sidebarHeader}>
          <Link href="/admin" className={styles.sidebarLogo}>
            <div className={styles.logoIcon}>
              <GraduationCap />
            </div>
            <div>
              <span className={styles.logoText}>MSU ADMIN</span>
              <span className={styles.logoSub}>Administration Portal</span>
            </div>
          </Link>
        </div>

        <nav className={styles.nav}>
          <span className={styles.navLabel}>Main Menu</span>
          {NAV_ITEMS.map((item) => {
            const isActive = isActivePath(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isActive ? styles.navItemActive : ""}`}
              >
                <item.icon />
                {item.label}
              </Link>
            );
          })}

          {/* Enquiry Management — collapsible parent, exactly one entry */}
          <div className={styles.navGroup}>
            <button
              type="button"
              className={`${styles.navItem} ${
                isActivePath(ENQUIRY_NAV_GROUP.href, pathname)
                  ? styles.navItemActive
                  : ""
              }`}
              onClick={() => setEnquiryGroupOpen((open) => !open)}
              aria-expanded={enquiryGroupOpen}
              aria-controls="enquiry-nav-children"
            >
              <ENQUIRY_NAV_GROUP.icon />
              {ENQUIRY_NAV_GROUP.label}
              <ChevronRight
                aria-hidden="true"
                className={`${styles.navChevron} ${
                  enquiryGroupOpen ? styles.navChevronOpen : ""
                }`}
              />
            </button>

            {/* Kept mounted so the section can animate both open and closed;
                collapsed content is `visibility: hidden` (not focusable). */}
            <div
              className={`${styles.navSubList} ${
                enquiryGroupOpen ? styles.navSubListOpen : ""
              }`}
              id="enquiry-nav-children"
            >
              <div className={styles.navSubInner}>
                {ENQUIRY_NAV_GROUP.children.map((child) => {
                  const isActive = isActivePath(child.href, pathname);
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      className={`${styles.navItem} ${styles.navSubItem} ${
                        isActive ? styles.navItemActive : ""
                      }`}
                    >
                      <child.icon />
                      {child.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>

          {extraNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${
                isActivePath(item.href, pathname) ? styles.navItemActive : ""
              }`}
            >
              <item.icon />
              {item.label}
            </Link>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          {admin && (
            <div className={styles.adminInfo}>
              <div className={styles.adminAvatar}>{initials}</div>
              <div>
                <div className={styles.adminName}>{admin.name}</div>
                <div className={styles.adminRole}>
                  <Shield size={10} /> {admin.role}
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            className={styles.navItem}
            onClick={handleLogout}
          >
            <LogOut />
            Logout
          </button>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <button
              type="button"
              className={styles.menuBtn}
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label="Toggle sidebar"
            >
              {sidebarOpen ? <X /> : <Menu />}
            </button>
            <h1 className={styles.pageTitle}>{pageTitle}</h1>
          </div>
          <div className={styles.headerRight}>
            <Link href="/" className={styles.viewSite} aria-label="View public site">
              <GraduationCap />
              <span className={styles.viewSiteLabel}>View Site</span>
            </Link>

            {/* Notifications — real dashboard totals, loaded on first open. */}
            <div className={styles.menuWrap} ref={notifyRef}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={toggleNotifications}
                aria-haspopup="menu"
                aria-expanded={openMenu === "notifications"}
                aria-label="Notifications"
              >
                <Bell />
                {notifyCount > 0 && <span className={styles.notifyDot} aria-hidden="true" />}
              </button>

              {/* Kept mounted (hidden when closed) so it animates both ways. */}
              <div
                className={`${styles.dropdown} ${styles.dropdownRight} ${
                  openMenu === "notifications" ? styles.dropdownOpen : ""
                }`}
                role="menu"
                aria-hidden={openMenu !== "notifications"}
              >
                <div className={styles.dropdownHeader}>
                  <span className={styles.dropdownTitle}>Notifications</span>
                </div>
                {notifyLoading ? (
                  <p className={styles.dropdownMuted}>Loading…</p>
                ) : notifyError ? (
                  <p className={styles.dropdownMuted}>
                    Unable to load notifications.
                  </p>
                ) : notifyItems.length === 0 ? (
                  <p className={styles.dropdownMuted}>
                    Nothing needs attention right now.
                  </p>
                ) : (
                  <ul className={styles.notifyList}>
                    {notifyItems.map((item) => (
                      <li key={item.label}>
                        <Link href={item.href} className={styles.notifyItem}>
                          <span className={styles.notifyCount}>{item.count}</span>
                          <span className={styles.notifyText}>{item.label}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Admin profile + account actions. */}
            <div className={styles.menuWrap} ref={profileRef}>
              <button
                type="button"
                className={styles.profileBtn}
                onClick={toggleProfile}
                aria-haspopup="menu"
                aria-expanded={openMenu === "profile"}
              >
                <span className={styles.profileAvatar}>{initials}</span>
                <span className={styles.profileText}>
                  <span className={styles.profileName}>{admin?.name ?? "Administrator"}</span>
                  <span className={styles.profileRole}>{admin?.role ?? ""}</span>
                </span>
                <ChevronDown
                  className={`${styles.profileChevron} ${
                    openMenu === "profile" ? styles.profileChevronOpen : ""
                  }`}
                  aria-hidden="true"
                />
              </button>

              {/* Kept mounted (hidden when closed) so it animates both ways. */}
              <div
                className={`${styles.dropdown} ${styles.dropdownRight} ${
                  openMenu === "profile" ? styles.dropdownOpen : ""
                }`}
                role="menu"
                aria-hidden={openMenu !== "profile"}
              >
                <div className={styles.dropdownHeader}>
                  <span className={styles.dropdownTitle}>
                    {admin?.name ?? "Administrator"}
                  </span>
                  {admin?.email && (
                    <span className={styles.dropdownSubtitle}>{admin.email}</span>
                  )}
                </div>

                {extraNavItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={styles.dropdownLink}
                    role="menuitem"
                  >
                    <item.icon />
                    {item.label}
                  </Link>
                ))}

                <button
                  type="button"
                  className={styles.dropdownLink}
                  onClick={handleLogout}
                  role="menuitem"
                >
                  <LogOut />
                  Logout
                </button>
              </div>
            </div>
          </div>
        </header>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
