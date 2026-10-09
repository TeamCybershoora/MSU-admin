"use client";

/**
 * Super Admin Dashboard — /admin/super-admin
 *
 * A role-gated shell that hosts two screens:
 *   Screen A — Overview            (default)
 *   Screen B — Geography / Shares
 * with a clean switcher between them.
 *
 * Screen transition (per the brief): the sidebar, app shell and top bar stay
 * fixed — only the CONTENT PANEL transitions out (opacity 1→0, scale 1→.98,
 * ~260 ms) and the incoming screen then runs its own entrance choreography.
 * The shell is never re-animated just because the screen changed.
 *
 * Access control: the role decoded from the stored JWT is used ONLY to decide
 * what to render (via `useStoredRole()`, the existing auth utility). Every
 * admin API independently enforces authentication server-side, so a normal
 * admin who renders this page still gets 403 from the API. No auth, JWT, AES or
 * bcrypt code is touched here.
 */

import { useEffect, useRef, useState } from "react";
import { LayoutDashboard, Lock, MapPinned, type LucideIcon } from "lucide-react";
import { useStoredRole } from "@/lib/auth";
import { useReducedMotion } from "@/components/dashboard/hooks";
import Card from "@/components/ui/card";
import styles from "./page.module.css";
import OverviewScreen from "./screen-a";
import GeographySharesScreen from "./screen-b";

type ScreenKey = "overview" | "geography";

/** The two screens, in switcher order. */
const SCREENS: ReadonlyArray<{ key: ScreenKey; label: string; icon: LucideIcon }> = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "geography", label: "Geography & Shares", icon: MapPinned },
];

/** Content-panel exit duration — must match `.contentPanel` in page.module.css. */
const SWITCH_MS = 260;

export default function SuperAdminDashboardPage() {
  const role = useStoredRole();
  const reduced = useReducedMotion();
  const [screen, setScreen] = useState<ScreenKey>("overview");
  const [panelVisible, setPanelVisible] = useState(true);
  const switchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending swap if the page unmounts mid-transition.
  useEffect(
    () => () => {
      if (switchTimer.current) clearTimeout(switchTimer.current);
    },
    []
  );

  function changeScreen(next: ScreenKey) {
    if (next === screen) return;
    if (switchTimer.current) clearTimeout(switchTimer.current);

    // Reduced motion: swap immediately, no exit transition.
    if (reduced) {
      setScreen(next);
      setPanelVisible(true);
      return;
    }

    setPanelVisible(false);
    switchTimer.current = setTimeout(() => {
      setScreen(next);
      setPanelVisible(true);
    }, SWITCH_MS);
  }

  // Presentation-only gate. `role` is "" until the client reads the store, so
  // this never flashes on first paint. Real authorization is server-side.
  if (role && role !== "super_admin") {
    return (
      <div className={styles.page}>
        <Card>
          <div className={styles.restricted}>
            <div className={styles.restrictedIcon}>
              <Lock />
            </div>
            <h2 className={styles.restrictedTitle}>Super Admin access required</h2>
            <p className={styles.restrictedText}>
              This dashboard is restricted to Super Administrators. Contact a
              Super Admin if you need access.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div
        className={styles.screenSwitch}
        role="tablist"
        aria-label="Super Admin dashboard screens"
      >
        {SCREENS.map((item) => {
          const isActive = item.key === screen;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`${styles.screenTab} ${isActive ? styles.screenTabActive : ""}`}
              onClick={() => changeScreen(item.key)}
            >
              <item.icon className={styles.screenTabIcon} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Only this panel transitions between screens; the shell stays fixed. */}
      <div
        className={`${styles.contentPanel} ${
          panelVisible ? "" : styles.contentPanelOut
        }`}
      >
        {screen === "overview" ? <OverviewScreen /> : <GeographySharesScreen />}
      </div>
    </div>
  );
}
