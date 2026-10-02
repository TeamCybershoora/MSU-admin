"use client";

/**
 * Client-side CRUD helpers for the Academic Structure admin UI.
 *
 * Everything is addressed generically — one structure by id, then one semester
 * by number and one subject by code — so the same helpers manage BCA 2025-26
 * and B.Tech 2026-27; nothing is programme-specific. The admin JWT from
 * localStorage is attached automatically, and authorization is always re-checked
 * server-side.
 *
 * The API surface used (all in app/api/admin/academic-structure/route.ts):
 *   GET    ?search=&status=&page=&limit=   list (summaries)
 *   GET    ?id=<id>                        one structure (full curriculum)
 *   POST                                   create a structure
 *   PATCH  { id, … }                       rename / status / semester / subject
 *   DELETE ?id=&…&confirm=permanent        remove subject / semester / structure
 */

import { getStoredToken } from "@/lib/auth";
import type {
  ElectiveSelectionRule,
  ProgrammeStructureStatus,
  SubjectCategory,
  SubjectType,
} from "@/lib/programme-structure";
import type {
  Pagination,
  ProgrammeStructureFilters,
  ProgrammeStructureRecord,
  ProgrammeStructureSummary,
} from "./types";

export interface ApiOutcome {
  success: boolean;
  message: string;
  /** Parsed JSON response body when the server sent one. */
  body?: Record<string, unknown> | null;
}

async function request(path: string, init: RequestInit): Promise<ApiOutcome> {
  try {
    const res = await fetch(path, init);
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!res.ok || !body?.success) {
      return {
        success: false,
        message:
          typeof body?.message === "string"
            ? body.message
            : "The request could not be completed.",
        body,
      };
    }

    return {
      success: true,
      message:
        typeof body.message === "string" ? body.message : "Saved successfully.",
      body,
    };
  } catch {
    return { success: false, message: "Unable to connect to server." };
  }
}

function authHeaders(): HeadersInit {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function jsonRequest(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  };
}

function authRequest(method: string): RequestInit {
  return { method, headers: authHeaders() };
}

/* ── Reads ─────────────────────────────────────────────────────── */

export interface StructureListResult {
  success: boolean;
  message: string;
  data?: ProgrammeStructureSummary[];
  pagination?: Pagination;
  filters?: ProgrammeStructureFilters;
}

/** List programme structures (paginated, with search + status filter). */
export async function listProgrammeStructures(params: {
  page?: number;
  search?: string;
  status?: string;
  /** Page size (server caps at 100). Defaults to 20 for the list page. */
  limit?: number;
}): Promise<StructureListResult> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    limit: String(params.limit ?? 20),
  });
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);

  const outcome = await request(
    `/api/admin/academic-structure?${query}`,
    authRequest("GET")
  );

  if (!outcome.success) {
    return { success: false, message: outcome.message };
  }

  const body = outcome.body ?? {};
  return {
    success: true,
    message: "",
    data: Array.isArray(body.data)
      ? (body.data as ProgrammeStructureSummary[])
      : [],
    pagination: body.pagination as Pagination | undefined,
    filters: body.filters as ProgrammeStructureFilters | undefined,
  };
}

/** Load ONE structure with its full curriculum (null when not found). */
export async function fetchProgrammeStructure(
  id: string
): Promise<ProgrammeStructureRecord | null> {
  const query = new URLSearchParams({ id });
  const outcome = await request(
    `/api/admin/academic-structure?${query}`,
    authRequest("GET")
  );

  const data = outcome.body?.data;
  return outcome.success && data && typeof data === "object"
    ? (data as ProgrammeStructureRecord)
    : null;
}

/* ── Writes ────────────────────────────────────────────────────── */

export interface StructureFieldsPayload {
  programmeCode: string;
  programmeName: string;
  academicSession: string;
  status: ProgrammeStructureStatus;
}

/** Create a new programme structure (the curriculum can be filled in later). */
export function createProgrammeStructure(
  payload: StructureFieldsPayload
): Promise<ApiOutcome> {
  return request("/api/admin/academic-structure", jsonRequest("POST", payload));
}

/** Rename a structure or change its status (ACTIVE ⇄ INACTIVE). */
export function updateProgrammeStructure(
  id: string,
  changes: { programmeName?: string; status?: ProgrammeStructureStatus }
): Promise<ApiOutcome> {
  return request(
    "/api/admin/academic-structure",
    jsonRequest("PATCH", { id, ...changes })
  );
}

/**
 * Add or edit ONE semester.
 *
 * `originalSemesterNumber` names the semester being edited — omitting it ADDS a
 * new semester, so a genuinely new semester is never mistaken for an edit of an
 * existing one. Editing without `subjects` leaves the semester's subjects intact.
 */
export function saveSemester(
  id: string,
  semester: {
    semesterNumber: number;
    semesterName: string;
    status: ProgrammeStructureStatus;
  },
  originalSemesterNumber?: number
): Promise<ApiOutcome> {
  return request(
    "/api/admin/academic-structure",
    jsonRequest("PATCH", {
      id,
      semester,
      ...(originalSemesterNumber !== undefined
        ? { originalSemesterNumber }
        : {}),
    })
  );
}

/**
 * Add or edit ONE subject inside a semester.
 *
 * `originalSubjectCode` names the subject being edited (omitted = add). The
 * assessment `totalMax` is always recomputed by the server, so whatever the form
 * displayed can never disagree with what is stored.
 */
export function saveSubject(
  id: string,
  semesterNumber: number,
  subject: {
    subjectCode: string;
    subjectName: string;
    credits: number;
    subjectType: SubjectType;
    category: SubjectCategory;
    status: ProgrammeStructureStatus;
    /** "" = compulsory; otherwise the elective group this subject is an option of. */
    electiveGroup: string;
    selectionRule: ElectiveSelectionRule | null;
    assessment: {
      internalMax: number;
      externalMax: number;
      practicalMax: number;
      /** null = the source states no pass mark. */
      minimumMarks: number | null;
      internalQualifying: boolean;
    };
  },
  originalSubjectCode?: string
): Promise<ApiOutcome> {
  return request(
    "/api/admin/academic-structure",
    jsonRequest("PATCH", {
      id,
      semesterNumber,
      subject: {
        ...subject,
        ...(originalSubjectCode ? { originalSubjectCode } : {}),
      },
    })
  );
}

/* ── Permanent removals (always explicit) ──────────────────────── */

const PERMANENT = "permanent";

/** Remove ONE subject definition from a semester. */
export function deleteSubject(
  id: string,
  semesterNumber: number,
  subjectCode: string
): Promise<ApiOutcome> {
  const query = new URLSearchParams({
    id,
    semesterNumber: String(semesterNumber),
    subjectCode,
    confirm: PERMANENT,
  });
  return request(`/api/admin/academic-structure?${query}`, authRequest("DELETE"));
}

/** Remove ONE semester together with its subject definitions. */
export function deleteSemester(
  id: string,
  semesterNumber: number
): Promise<ApiOutcome> {
  const query = new URLSearchParams({
    id,
    semesterNumber: String(semesterNumber),
    confirm: PERMANENT,
  });
  return request(`/api/admin/academic-structure?${query}`, authRequest("DELETE"));
}

/**
 * Remove a WHOLE programme structure. The server refuses while the structure is
 * ACTIVE (deactivate first) and refuses without the explicit confirmation.
 */
export function deleteProgrammeStructure(id: string): Promise<ApiOutcome> {
  const query = new URLSearchParams({
    id,
    scope: "structure",
    confirm: PERMANENT,
  });
  return request(`/api/admin/academic-structure?${query}`, authRequest("DELETE"));
}
