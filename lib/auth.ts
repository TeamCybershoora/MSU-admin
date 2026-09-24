"use client";

/**
 * Frontend authentication module for the Admin Portal.
 */

import { useSyncExternalStore } from "react";

export interface MsuUser {
  name: string;
  email: string;
  role?: string;
  accountType?: "student" | "admin";
  signedInAt: number;
}

const USER_KEY = "msu-user";
const TOKEN_KEY = "msu-token";
export const AUTH_CHANGE_EVENT = "msu-auth-change";

/** Clears all client-side auth state. */
export function clearAuthSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(USER_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
}

/* ── Session helpers ─────────────────────────────────── */

export function getStoredUser(): MsuUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MsuUser;
  } catch {
    return null;
  }
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function signOutUser() {
  clearAuthSession();
}

/**
 * Read the role claim from the stored JWT.
 *
 * DISPLAY ONLY — this is used to decide what to render. Every authorization
 * decision is made server-side from the Admin document (see lib/admin-auth.ts),
 * so a tampered claim cannot grant anything.
 */
export function getStoredRole(): string {
  const token = getStoredToken();
  if (!token) return "";
  try {
    const payload = JSON.parse(atob(token.split(".")[1])) as { role?: string };
    return payload.role || "";
  } catch {
    return "";
  }
}

/* ── React bindings ──────────────────────────────────── */

/**
 * Stable subscription to the client auth store.
 *
 * Declared at module scope so its identity never changes — a new function per
 * render would make useSyncExternalStore tear down and re-subscribe each time.
 */
function subscribeToAuthStore(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AUTH_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(AUTH_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/**
 * The signed-in admin's role, read straight from the stored JWT.
 *
 * The session lives in localStorage — an external, mutable store — so this is
 * read with useSyncExternalStore instead of being copied into React state by an
 * effect. Reads stay individually correct, sign-out (which dispatches
 * AUTH_CHANGE_EVENT) and other tabs (which fire `storage`) both re-render
 * consumers, and the server snapshot is empty so hydration matches SSR.
 *
 * DISPLAY ONLY — see getStoredRole above. Authorization is always server-side.
 */
export function useStoredRole(): string {
  return useSyncExternalStore(subscribeToAuthStore, getStoredRole, () => "");
}
