"use client";

/**
 * UploadedSyllabusPanel — "Uploaded Syllabus": the syllabus documents that are
 * ALREADY stored, listed without offering any upload action.
 *
 * The existing data model keeps syllabus documents in two layers, and to an
 * administrator both are "uploaded syllabus", so the listing unions them:
 *
 *   Programme → ProgrammeSyllabus.pdfUrl
 *                (one official PDF per programme + academic session)
 *   Semester  → Syllabus.pdfUrl
 *                (one document per programme + session + semester)
 *   Subject   → Syllabus.subjects[].pdfUrl
 *                (a subject attachment inside a semester document)
 *
 * READ-ONLY BY DESIGN: it never uploads, replaces or deletes. It reuses the
 * existing endpoints (GET /api/admin/programme-syllabus and
 * GET /api/admin/syllabus) and the existing public PDF route for the View and
 * Download actions — no storage path, id or credential beyond the document's
 * own URL is ever exposed.
 *
 * The whole list is fetched once and filtered in the browser, so a search also
 * matches a FILENAME (the server-side `search` filter matches programme,
 * session and subject fields but not `pdfName`). Records are walked page by
 * page with the same convention the Academic Structure picker uses.
 *
 * "Uploaded" is decided by the data, not by a separate flag: an entry is listed
 * only when its document carries a stored PDF reference.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Calendar,
  Download,
  ExternalLink,
  FileText,
  Filter,
  GraduationCap,
  Search,
  X,
} from "lucide-react";
import Card, { CardHeader } from "@/components/ui/card";
import SearchableSelect from "@/components/ui/searchable-select";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import {
  fetchProgrammeSyllabus,
  listSyllabus,
} from "./syllabus-api";
import type { ProgrammeSyllabusRecord, SyllabusRecord } from "./types";
import styles from "./syllabus.module.css";

/** Page size for walking the structured list (the server caps a page at 100). */
const PAGE_LIMIT = 100;
/** Safety cap so a pathological collection cannot loop forever (1000 docs). */
const MAX_PAGES = 10;
/** Path the stored PDF references use (see app/api/syllabus/pdf/[id]). */
const PDF_PATH_PREFIX = "/api/syllabus/pdf/";

type EntryKind = "programme" | "semester" | "subject";

interface UploadedEntry {
  /** Stable React key — unique per document, never per programme. */
  key: string;
  kind: EntryKind;
  /** Filename when stored, otherwise a descriptive fallback. */
  title: string;
  programme: string;
  academicSession: string | null;
  semester: number | null;
  subjectCode: string | null;
  pdfUrl: string;
  /** Upload date of the record the document belongs to (null when absent). */
  uploadedAt: string | null;
}

const KIND_LABELS: Record<EntryKind, string> = {
  programme: "Programme PDF",
  semester: "Semester PDF",
  subject: "Subject PDF",
};

/**
 * Build the URL used by View/Download.
 *
 * A stored reference keeps the origin that issued it, which may differ from the
 * host the administrator is using right now (a record uploaded on a dev port,
 * or a deployed instance whose public host differs from the internal one). The
 * PATH of a syllabus PDF reference is served by THIS application, so it is
 * re-based onto the current origin; any other URL (an external link an operator
 * legitimately stored) is returned untouched.
 */
function resolveStoredPdfUrl(pdfUrl: string): string {
  if (typeof window === "undefined") return pdfUrl;

  try {
    const stored = new URL(pdfUrl, window.location.origin);
    if (!stored.pathname.startsWith(PDF_PATH_PREFIX)) return pdfUrl;
    return `${window.location.origin}${stored.pathname}${stored.search}`;
  } catch {
    return pdfUrl;
  }
}

/**
 * Same reference, served as an attachment: the existing route already supports
 * `?download=1` for this, so no separate download endpoint is introduced.
 */
function toDownloadUrl(pdfUrl: string): string {
  try {
    const url = new URL(pdfUrl, window.location.origin);
    url.searchParams.set("download", "1");
    return url.toString();
  } catch {
    return pdfUrl;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Academic identity label; a legacy record is never given a guessed session. */
function identityOf(programme: string, academicSession: string | null): string {
  return academicSession ? `${programme} — ${academicSession}` : `${programme} · legacy (no session)`;
}

/** Flatten the two document layers into one list of uploaded documents. */
function buildEntries(
  programmeDocs: ProgrammeSyllabusRecord[],
  structured: SyllabusRecord[]
): UploadedEntry[] {
  const entries: UploadedEntry[] = [];

  for (const doc of programmeDocs) {
    if (!doc.pdfUrl) continue;
    entries.push({
      key: `programme:${doc.id}`,
      kind: "programme",
      title: doc.pdfName || "Official programme syllabus",
      programme: doc.programme,
      academicSession: doc.academicSession ?? null,
      semester: null,
      subjectCode: null,
      pdfUrl: doc.pdfUrl,
      uploadedAt: doc.createdAt ?? null,
    });
  }

  for (const record of structured) {
    if (record.pdfUrl) {
      entries.push({
        key: `semester:${record.id}`,
        kind: "semester",
        title: record.pdfName || `Semester ${record.semester} syllabus`,
        programme: record.programme,
        academicSession: record.academicSession ?? null,
        semester: record.semester,
        subjectCode: null,
        pdfUrl: record.pdfUrl,
        uploadedAt: record.createdAt ?? null,
      });
    }

    for (const subject of record.subjects ?? []) {
      if (!subject.pdfUrl) continue;
      entries.push({
        key: `subject:${record.id}:${subject.subjectCode}`,
        kind: "subject",
        title: `${subject.subjectName} (${subject.subjectCode})`,
        programme: record.programme,
        academicSession: record.academicSession ?? null,
        semester: record.semester,
        subjectCode: subject.subjectCode,
        pdfUrl: subject.pdfUrl,
        uploadedAt: record.createdAt ?? null,
      });
    }
  }

  return entries;
}

export default function UploadedSyllabusPanel() {
  const [entries, setEntries] = useState<UploadedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [programmeFilter, setProgrammeFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      // Programme-level documents: one page, naturally bounded (one per
      // programme + session).
      const programmeDocs = await fetchProgrammeSyllabus();

      // Structured documents: walk every page, using the same convention as the
      // Academic Structure picker (the server caps one page at 100).
      const structured: SyllabusRecord[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const result = await listSyllabus({ page, limit: PAGE_LIMIT });

        if (!result.success) {
          setError(result.message || "Unable to load uploaded syllabus.");
          return;
        }

        structured.push(...(result.data ?? []));
        totalPages = result.pagination?.totalPages ?? 1;
        page += 1;
      } while (page <= totalPages && page <= MAX_PAGES);

      setEntries(buildEntries(programmeDocs, structured));
    } catch {
      setError("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  /** Programme options come from the loaded documents — never a guessed list. */
  const programmeOptions = useMemo(
    () => Array.from(new Set(entries.map((e) => e.programme))).sort(),
    [entries]
  );

  /** Sessions are scoped to the selected programme, like the identity picker. */
  const sessionOptions = useMemo(
    () =>
      Array.from(
        new Set(
          entries
            .filter((e) => !programmeFilter || e.programme === programmeFilter)
            .map((e) => e.academicSession)
        )
      )
        .filter((session): session is string => !!session)
        .sort()
        .reverse(),
    [entries, programmeFilter]
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();

    return entries
      .filter((e) => !programmeFilter || e.programme === programmeFilter)
      .filter((e) => !sessionFilter || e.academicSession === sessionFilter)
      .filter((e) => {
        if (!term) return true;
        return [
          e.title,
          e.programme,
          e.academicSession ?? "",
          e.subjectCode ?? "",
          String(e.semester ?? ""),
          KIND_LABELS[e.kind],
        ]
          .join(" ")
          .toLowerCase()
          .includes(term);
      })
      .sort((a, b) => {
        const at = a.uploadedAt ? Date.parse(a.uploadedAt) : 0;
        const bt = b.uploadedAt ? Date.parse(b.uploadedAt) : 0;
        return bt - at;
      });
  }, [entries, programmeFilter, sessionFilter, search]);

  const filtersActive = !!(search || programmeFilter || sessionFilter);

  function clearFilters() {
    setSearch("");
    setProgrammeFilter("");
    setSessionFilter("");
  }

  function handleProgrammeChange(value: string) {
    setProgrammeFilter(value);
    // A session belongs to one programme — drop a selection that no longer applies.
    if (sessionFilter && !entries.some((e) => e.programme === value && e.academicSession === sessionFilter)) {
      setSessionFilter("");
    }
  }

  return (
    <Card>
      <CardHeader
        title={`Uploaded Syllabus (${entries.length})`}
        subtitle="Syllabus documents already stored for this portal — programme-level official PDFs and semester/subject attachments. This view is read-only; use Manage Syllabus to upload or replace a document."
      />

      <div className={styles.docToolbar}>
        <div className={styles.docSearch}>
          <Search size={16} />
          <input
            type="text"
            placeholder="Search by filename, programme, session or subject..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search uploaded syllabus"
          />
          {search && (
            <button
              type="button"
              className={styles.docClear}
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className={styles.docFilterRow}>
          <Filter size={14} />
          <SearchableSelect
            id="uploaded-syllabus-programme-filter"
            variant="compact"
            label="Filter by programme"
            placeholder="All Programmes"
            value={programmeFilter}
            options={[
              { value: "", label: "All Programmes" },
              ...programmeOptions.map((programme) => ({
                value: programme,
                label: programme,
              })),
            ]}
            triggerClassName={styles.docSelect}
            onChange={(value) => handleProgrammeChange(value)}
          />

          <SearchableSelect
            id="uploaded-syllabus-session-filter"
            variant="compact"
            label="Filter by academic session"
            placeholder="All Sessions"
            value={sessionFilter}
            options={[
              { value: "", label: "All Sessions" },
              ...sessionOptions.map((session) => ({
                value: session,
                label: session,
              })),
            ]}
            triggerClassName={styles.docSelect}
            disabled={sessionOptions.length === 0}
            onChange={(value) => setSessionFilter(value)}
          />

          {filtersActive && (
            <button
              type="button"
              className={styles.docClearFilters}
              onClick={clearFilters}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className={styles.docLoading}>
          <div className={styles.docSpinner} />
          <p>Loading uploaded syllabus...</p>
        </div>
      ) : error ? (
        <ErrorState
          title="Unable to load uploaded syllabus"
          description={error}
          onRetry={load}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title="No syllabus documents have been uploaded yet"
          description="Upload a syllabus PDF in Manage Syllabus and it will be listed here."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="No uploaded syllabus matches your filters"
          description="Clear the search or filters to see every uploaded document."
        />
      ) : (
        <>
          <p className={styles.docCount}>
            Showing {visible.length} of {entries.length} uploaded document
            {entries.length === 1 ? "" : "s"}.
          </p>

          <div className={styles.docList}>
            {visible.map((entry) => {
              const viewUrl = resolveStoredPdfUrl(entry.pdfUrl);

              return (
                <article key={entry.key} className={styles.docRow}>
                  <div className={styles.docMain}>
                    <span className={styles.docTitle}>
                      <FileText size={15} /> {entry.title}
                    </span>
                    <span className={styles.docMeta}>
                      <span className={styles.docBadge}>{KIND_LABELS[entry.kind]}</span>
                      <span>
                        <GraduationCap size={13} />{" "}
                        {identityOf(entry.programme, entry.academicSession)}
                      </span>
                      {entry.semester !== null && (
                        <span>Semester {entry.semester}</span>
                      )}
                    </span>
                  </div>

                  <span className={styles.docDate}>
                    <Calendar size={13} /> {formatDate(entry.uploadedAt)}
                  </span>

                  <div className={styles.docActions}>
                    <a
                      className={styles.pdfLink}
                      href={viewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} /> View
                    </a>
                    <a
                      className={styles.pdfLink}
                      href={toDownloadUrl(entry.pdfUrl)}
                      download
                    >
                      <Download size={13} /> Download
                    </a>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
