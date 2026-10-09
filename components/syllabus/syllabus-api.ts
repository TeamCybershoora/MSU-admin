"use client";

/**
 * Client-side CRUD helpers for the syllabus admin UI.
 *
 * Every operation is addressed by the ACADEMIC IDENTITY the server validates
 * against ProgrammeStructure — programme + academicSession (+ semester +
 * subjectCode) — so the same call manages BCA/2023-24/Semester 1 and
 * B.Tech/2026-27/Semester 2. No helper is named after a programme, session,
 * semester or subject, and the admin JWT (localStorage) is attached
 * automatically.
 *
 * API surface used:
 *   GET    /api/admin/syllabus                  — list (filters include academicSession)
 *   POST   /api/admin/syllabus                  — create/upsert a semester document
 *   PATCH  /api/admin/syllabus                  — update a semester/subject/PDF
 *   DELETE /api/admin/syllabus                  — delete subject/semester/identity
 *   GET/POST/DELETE /api/admin/programme-syllabus — official programme PDF (per identity)
 *   POST   /api/admin/syllabus/upload           — store a PDF (shared, unchanged)
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
export async function listSyllabus(params: {
  page?: number;
  search?: string;
  programme?: string;
  academicSession?: string;
  /** Page size (server caps this at 100). Defaults to the existing 50. */
  limit?: number;
}): Promise<SyllabusListResult> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    limit: String(params.limit ?? 50),
  });
  if (params.search) query.set("search", params.search);
  if (params.programme) query.set("programme", params.programme);
  if (params.academicSession) query.set("academicSession", params.academicSession);

  const outcome = await request(`/api/admin/syllabus?${query}`, authInit("GET"));

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

/**
 * Create a semester document for an academic identity, or upsert the existing
 * one. `subjects` omitted leaves the existing subject list untouched.
 */
export function saveSyllabus(payload: {
  programme: string;
  academicSession: string;
  semester: number;
  subjects?: SyllabusSubject[];
  pdfUrl?: string | null;
  pdfName?: string | null;
}): Promise<ApiOutcome> {
  return request("/api/admin/syllabus", jsonInit("POST", payload));
}

/**
 * Update ONE semester document, identified by programme + academicSession +
 * semester. `pdfUrl === undefined` leaves the existing attachment untouched.
 */
export function updateSemester(
  programme: string,
  academicSession: string,
  semester: number,
  changes: {
    semesterNumber?: number;
    pdfUrl?: string | null;
    pdfName?: string | null;
  }
): Promise<ApiOutcome> {
  return request(
    "/api/admin/syllabus",
    jsonInit("PATCH", { programme, academicSession, semester, ...changes })
  );
}

/**
 * Add or edit ONE subject inside a semester.
 *
 * `originalSubjectCode` names the subject being EDITED. When it is omitted the
 * call ADDS a new subject. The subject name and academic metadata are always
 * read from ProgrammeStructure by the server, so whatever this payload carries
 * for `subjectName` is not authoritative.
 */
export function updateSubject(
  programme: string,
  academicSession: string,
  semester: number,
  subject: SyllabusSubject,
  originalSubjectCode?: string
): Promise<ApiOutcome> {
  return request(
    "/api/admin/syllabus",
    jsonInit("PATCH", {
      programme,
      academicSession,
      semester,
      subject: {
        // Only the code and document links are meaningful; the server reads the
        // name from the academic structure.
        subjectCode: subject.subjectCode,
        syllabusUrl: subject.syllabusUrl,
        pdfUrl: subject.pdfUrl,
        ...(originalSubjectCode ? { originalSubjectCode } : {}),
      },
    })
  );
}

/** Remove ONE subject, identified by its code, within an academic identity. */
export function deleteSubject(
  programme: string,
  academicSession: string,
  semester: number,
  subjectCode: string
): Promise<ApiOutcome> {
  const params = new URLSearchParams({
    programme,
    academicSession,
    semester: String(semester),
    subjectCode,
  });
  return request(`/api/admin/syllabus?${params}`, authInit("DELETE"));
}

/** Remove ONE semester document (its subjects and semester PDF). */
export function deleteSemester(
  programme: string,
  academicSession: string,
  semester: number
): Promise<ApiOutcome> {
  const params = new URLSearchParams({
    programme,
    academicSession,
    semester: String(semester),
  });
  return request(`/api/admin/syllabus?${params}`, authInit("DELETE"));
}

/**
 * Remove EVERY semester/subject document of one academic identity.
 * The official programme PDF lives in a separate collection and is untouched.
 */
export function deleteStructuredSyllabus(
  programme: string,
  academicSession: string
): Promise<ApiOutcome> {
  const params = new URLSearchParams({
    programme,
    academicSession,
    scope: "programme",
  });
  return request(`/api/admin/syllabus?${params}`, authInit("DELETE"));
}

/** Official programme-level PDF — create or replace for one identity. */
export function saveProgrammeSyllabus(
  programme: string,
  academicSession: string,
  pdfUrl: string,
  pdfName: string | null
): Promise<ApiOutcome> {
  return request(
    "/api/admin/programme-syllabus",
    jsonInit("POST", { programme, academicSession, pdfUrl, pdfName })
  );
}

/**
 * Official programme-level PDF — remove (structured records stay intact).
 * A `null` session targets a legacy session-less document; no session is guessed.
 */
export function deleteProgrammeSyllabus(
  programme: string,
  academicSession: string | null
): Promise<ApiOutcome> {
  const params = new URLSearchParams({ programme });
  if (academicSession) params.set("academicSession", academicSession);
  return request(`/api/admin/programme-syllabus?${params}`, authInit("DELETE"));
}

/**
 * The EXISTING MSU programme catalogue, as exposed by the public read-only
 * endpoint GET /api/syllabus/programmes.
 *
 * The catalogue is DISCOVERED from stored data (ProgrammeStructure plus any
 * legacy syllabus-only code) — there is no separate programme collection. A
 * programme therefore appears here because a ProgrammeStructure exists for it,
 * or because a document predating the structure integration references it.
 * This is exactly the list the public syllabus feature offers, so Syllabus
 * Management and the public site can never disagree about which programmes
 * exist.
 */
export interface CatalogueProgramme {
  programmeCode: string;
  programmeName: string | null;
}

/** Read the existing programme catalogue (public, read-only). */
export async function listCatalogueProgrammes(): Promise<CatalogueProgramme[]> {
  try {
    const res = await fetch("/api/syllabus/programmes");
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: unknown;
    } | null;

    if (!res.ok || !body?.success || !Array.isArray(body.data)) return [];

    return (body.data as Record<string, unknown>[])
      .map((entry) => ({
        programmeCode:
          typeof entry.programmeCode === "string" ? entry.programmeCode : "",
        programmeName:
          typeof entry.programmeName === "string" ? entry.programmeName : null,
      }))
      .filter((entry) => entry.programmeCode !== "");
  } catch {
    return [];
  }
}

/** List programme-level syllabus documents (for the identity dropdown). */
export async function fetchProgrammeSyllabus(): Promise<
  ProgrammeSyllabusRecord[]
> {
  const outcome = await request("/api/admin/programme-syllabus", authInit("GET"));
  const data = outcome.body?.data;
  return outcome.success && Array.isArray(data)
    ? (data as ProgrammeSyllabusRecord[])
    : [];
}
