/**
 * Client-side helpers for the PUBLIC syllabus page.
 *
 * Thin GET wrappers around the public syllabus API layer plus the stale-
 * request guard the page uses. Mirrors the organisation of
 * components/syllabus/syllabus-api.ts (admin) and
 * components/academic-structure/academic-structure-api.ts (admin), but with
 * NO auth and NO write methods — the public page is strictly read-only.
 *
 * Type-only imports from @/lib/public-syllabus keep this module safe to bundle
 * in the browser: the server module (and mongoose with it) is fully erased at
 * compile time and never reaches the client runtime.
 */

import type {
  PublicProgramme,
  PublicSession,
  PublicSyllabusDetail,
} from "@/lib/public-syllabus";

/**
 * Outcome of one public API call. `status: 0` marks a network failure
 * (the request never reached the server), so the UI can distinguish
 * "cannot connect" from an API error response.
 */
export interface PublicApiOutcome<T> {
  success: boolean;
  status: number;
  message: string;
  data: T | null;
}

async function getJson<T>(url: string): Promise<PublicApiOutcome<T>> {
  try {
    const res = await fetch(url);

    type JsonBody = {
      success?: boolean;
      message?: string;
      data?: T;
    };

    let body: JsonBody | null = null;
    try {
      body = (await res.json()) as JsonBody | null;
    } catch {
      body = null;
    }

    if (!res.ok || !body?.success) {
      return {
        success: false,
        status: res.status,
        message: body?.message || "Unable to load the syllabus.",
        data: null,
      };
    }

    return {
      success: true,
      status: res.status,
      message: "",
      data: body.data ?? null,
    };
  } catch {
    return {
      success: false,
      status: 0,
      message: "Unable to connect to the server.",
      data: null,
    };
  }
}

/** GET /api/syllabus/programmes — every programme the public UI may offer. */
export function fetchPublicProgrammes(): Promise<
  PublicApiOutcome<PublicProgramme[]>
> {
  return getJson<PublicProgramme[]>("/api/syllabus/programmes");
}

/** GET /api/syllabus/sessions — sessions that actually exist for a programme. */
export function fetchPublicSessions(
  programmeCode: string
): Promise<PublicApiOutcome<PublicSession[]>> {
  const params = new URLSearchParams({ programmeCode });
  return getJson<PublicSession[]>(`/api/syllabus/sessions?${params}`);
}

/**
 * GET /api/syllabus — the syllabus for exactly one academic identity.
 * `semester` is omitted until the user picks one, so the page first loads the
 * session's semester list (and programme-level document) cheaply.
 */
export function fetchPublicSyllabus(query: {
  programmeCode: string;
  academicSession: string;
  semester?: string;
}): Promise<PublicApiOutcome<PublicSyllabusDetail>> {
  const params = new URLSearchParams({
    programmeCode: query.programmeCode,
    academicSession: query.academicSession,
  });
  if (query.semester) params.set("semester", query.semester);
  return getJson<PublicSyllabusDetail>(`/api/syllabus?${params}`);
}

/**
 * Stale-request guard — the public page's form of the monotonic request
 * sequence the admin notices page already uses (its `requestSeq` ref: only the
 * newest request may write state).
 *
 * Every effect run takes `next()` BEFORE clearing/fetching, so any response
 * still in flight from a previous programme/session/semester selection holds an
 * obsolete id and is discarded by `isCurrent` — an older response can never
 * overwrite a newer selection, even when requests resolve out of order.
 */
export function createRequestGuard(): {
  next: () => number;
  isCurrent: (id: number) => boolean;
} {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(id: number): boolean {
      return id === current;
    },
  };
}
