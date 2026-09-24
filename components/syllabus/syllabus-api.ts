"use client";

/**
 * Client-side CRUD helpers for the syllabus admin UI.
 *
 * Every operation is addressed by generic identifiers — programme + semester +
 * subjectCode — so the exact same call manages BCA Semester 1 and B.Tech
 * Semester 2. No helper is named after a programme, semester or subject, and
 * the admin JWT (localStorage) is attached automatically.
 *
 * API surface used (all existing, extended where noted):
 *   GET    /api/admin/syllabus                  — list (unchanged)
 *   POST   /api/admin/syllabus                  — create/upsert a semester
 *   PATCH  /api/admin/syllabus                  — update a semester/subject
 *   DELETE /api/admin/syllabus                  — delete subject/semester/all
 *   GET/POST/DELETE /api/admin/programme-syllabus — official programme PDF
 *   POST   /api/admin/syllabus/upload           — store a PDF (shared)
 */

import { getStoredToken } from "@/lib/auth";
import type {
  Pagination,
  ProgrammeSyllabusRecord,
  SyllabusFilters,
  SyllabusRecord,
  SyllabusSubject,
} from "./types";

export interface ApiOutcome {
  success: boolean;
  message: string;
  /** Parsed JSON response body when the server sent one. */
  body?: Record<string, unknown> | null;
}

/** Maximum accepted PDF size, mirrored from the server (lib/validation.ts). */
export const PDF_MAX_BYTES = 10 * 1024 * 1024;

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

function jsonInit(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  };
}

function authInit(method: string): RequestInit {
  return { method, headers: authHeaders() };
}

/** True when `value` is a well-formed http(s) URL. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * Client-side PDF checks (a convenience only — the server re-validates the raw
 * bytes). Returns an error message, or `null` when the file looks acceptable.
 */
export function validatePdfFile(file: File): string | null {
  if (file.type && file.type !== "application/pdf") {
    return "Only PDF files are accepted.";
  }
  if (file.size > PDF_MAX_BYTES) {
    return "PDF is too large. Maximum size is 10 MB.";
  }
  return null;
}

/**
 * Store a PDF in GridFS and return its issued reference.
 * Shared by the semester attachment and the official programme PDF.
 */
export function uploadSyllabusPdf(file: File): Promise<ApiOutcome> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/admin/syllabus/upload", {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
}

/** Read `pdfUrl` / `pdfName` off an upload response body. */
export function readUploadedPdf(
  body: Record<string, unknown> | null | undefined
): { pdfUrl: string | null; pdfName: string | null } {
  const pdfUrl = typeof body?.pdfUrl === "string" ? body.pdfUrl : null;
  const pdfName = typeof body?.pdfName === "string" ? body.pdfName : null;
  return { pdfUrl, pdfName };
}

/** Result of the paginated structured-syllabus list request. */
export interface SyllabusListResult {
  success: boolean;
  message: string;
  data?: SyllabusRecord[];
  pagination?: Pagination;
  filters?: SyllabusFilters;
}

/** List structured syllabus records (pagination + optional filters). */
export async function listSyllabi(params: {
  page?: number;
  search?: string;
  programme?: string;
}): Promise<SyllabusListResult> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    limit: "20",
  });
  if (params.search) query.set("search", params.search);
  if (params.programme) query.set("programme", params.programme);

  const outcome = await request(
    `/api/admin/syllabus?${query}`,
    authInit("GET")
  );

  if (!outcome.success) {
    return { success: false, message: outcome.message };
  }

  const body = outcome.body ?? {};
  return {
    success: true,
    message: "",
    data: Array.isArray(body.data) ? (body.data as SyllabusRecord[]) : [],
    pagination: body.pagination as Pagination | undefined,
    filters: body.filters as SyllabusFilters | undefined,
  };
}

/** Create a semester syllabus, or upsert the existing one. */
export function saveSyllabus(payload: {
  programme: string;
  semester: number;
  subjects: SyllabusSubject[];
  pdfUrl?: string | null;
  pdfName?: string | null;
}): Promise<ApiOutcome> {
  return request("/api/admin/syllabus", jsonInit("POST", payload));
}

/**
 * Update ONE semester, identified by programme + semester.
 * `pdfUrl === undefined` leaves the existing attachment untouched.
 */
export function updateSemester(
  programme: string,
  semester: number,
  changes: {
    semesterNumber?: number;
    pdfUrl?: string | null;
    pdfName?: string | null;
  }
): Promise<ApiOutcome> {
  return request(
    "/api/admin/syllabus",
    jsonInit("PATCH", { programme, semester, ...changes })
  );
}

/**
 * Add or edit ONE subject inside a semester.
 *
 * `originalSubjectCode` names the subject being EDITED. When it is omitted the
 * call ADDS a new subject: the server performs no existing-subject lookup for
 * the new code, so a genuinely new subject is accepted. A code that already
 * exists in the same programme + semester is still rejected by the server.
 */
export function updateSubject(
  programme: string,
  semester: number,
  subject: SyllabusSubject,
  originalSubjectCode?: string
): Promise<ApiOutcome> {
  return request(
    "/api/admin/syllabus",
    jsonInit("PATCH", {
      programme,
      semester,
      subject: {
        ...subject,
        // Only sent when editing, so the server can tell add from edit.
        ...(originalSubjectCode ? { originalSubjectCode } : {}),
      },
    })
  );
}

/** Remove ONE subject, identified by its code. */
export function deleteSubject(
  programme: string,
  semester: number,
  subjectCode: string
): Promise<ApiOutcome> {
  const params = new URLSearchParams({
    programme,
    semester: String(semester),
    subjectCode,
  });
  return request(`/api/admin/syllabus?${params}`, authInit("DELETE"));
}

/** Remove ONE semester (its document, subjects and semester PDF). */
export function deleteSemester(
  programme: string,
  semester: number
): Promise<ApiOutcome> {
  const params = new URLSearchParams({
    programme,
    semester: String(semester),
  });
  return request(`/api/admin/syllabus?${params}`, authInit("DELETE"));
}

/**
 * Remove EVERY semester/subject record of a programme.
 * The official programme PDF lives in a separate collection and is untouched.
 */
export function deleteStructuredSyllabus(programme: string): Promise<ApiOutcome> {
  const params = new URLSearchParams({ programme, scope: "programme" });
  return request(`/api/admin/syllabus?${params}`, authInit("DELETE"));
}

/** Official programme-level PDF — create or replace. */
export function saveProgrammeSyllabus(
  programme: string,
  pdfUrl: string,
  pdfName: string | null
): Promise<ApiOutcome> {
  return request(
    "/api/admin/programme-syllabus",
    jsonInit("POST", { programme, pdfUrl, pdfName })
  );
}

/** Official programme-level PDF — remove (structured records stay intact). */
export function deleteProgrammeSyllabus(programme: string): Promise<ApiOutcome> {
  const params = new URLSearchParams({ programme });
  return request(`/api/admin/programme-syllabus?${params}`, authInit("DELETE"));
}

/** List programme-level syllabus documents (for the programme dropdown). */
export async function fetchProgrammeSyllabi(): Promise<
  ProgrammeSyllabusRecord[]
> {
  const outcome = await request("/api/admin/programme-syllabus", authInit("GET"));
  const data = outcome.body?.data;
  return outcome.success && Array.isArray(data)
    ? (data as ProgrammeSyllabusRecord[])
    : [];
}
