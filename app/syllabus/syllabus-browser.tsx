"use client";

/**
 * Public syllabus browser — Programme → Academic Session → Semester →
 * session-specific syllabus data and documents.
 *
 * URL IS THE SOURCE OF TRUTH: the selection lives in
 * `/syllabus?programme=BCA&session=2023-24&semester=1`, so a refresh keeps the
 * selected academic session and browser back/forward re-runs exactly the
 * matching fetches. User selections push a history entry; automatic
 * single-option defaults use replace so history is not polluted.
 *
 * SESSION SWITCH SAFETY (why stale data can never survive a selection change):
 *  1. Every change handler clears the dependent state SYNCHRONOUSLY before
 *     navigating, so the old session's semester list / subjects / PDFs are
 *     removed in the same render the new selection appears.
 *  2. Every fetch runs under a `createRequestGuard()` id taken BEFORE the
 *     clear; responses whose id is no longer current are discarded, so an older
 *     request resolving after a newer one cannot overwrite it.
 *  3. Queries always carry programme + session (+ semester), never a bare
 *     programme+semester pair — the server rejects a session it does not know.
 *
 * The page talks only to the public read-only API (`/api/syllabus/*`); admin
 * endpoints are never called from here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookOpen, FileText } from "lucide-react";

import Card, { CardHeader } from "@/components/ui/card";
import Badge from "@/components/ui/badge";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import RecordList, {
  RecordCard,
  RecordField,
} from "@/components/ui/record-list";
import {
  formatAssessment,
  partitionSubjects,
  semesterLabel,
  selectionRuleLabel,
  subjectCategoryLabel,
  subjectTypeLabel,
  type CurriculumSubject,
} from "@/components/academic-structure/types";
import {
  createRequestGuard,
  fetchPublicProgrammes,
  fetchPublicSessions,
  fetchPublicSyllabus,
} from "@/components/syllabus-public/public-syllabus-api";
import type {
  PublicProgramme,
  PublicSession,
  PublicSyllabusDetail,
} from "@/lib/public-syllabus";
import styles from "./page.module.css";

/** How a failed load should be presented (404 is "empty", not "broken"). */
interface LoadError {
  kind: "empty" | "error";
  message: string;
  retryable: boolean;
}

function toLoadError(outcome: { status: number; message: string }): LoadError {
  if (outcome.status === 404) {
    return { kind: "empty", message: outcome.message, retryable: false };
  }
  if (outcome.status === 400) {
    return { kind: "error", message: outcome.message, retryable: false };
  }
  // 0 = network failure, 500 = server error — both worth retrying.
  return { kind: "error", message: outcome.message, retryable: true };
}

/** A subject entry of a published syllabus document (legacy record shape). */
interface DocumentSubjectLink {
  subjectCode: string;
  syllabusUrl: string | null;
  pdfUrl: string | null;
}

function Loading({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status">
      <div className={styles.spinner} aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export default function SyllabusBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const programmeParam = (searchParams.get("programme") ?? "")
    .trim()
    .toUpperCase();
  const sessionParam = (searchParams.get("session") ?? "").trim();
  const semesterParam = (searchParams.get("semester") ?? "").trim();

  /* ── Data state ──────────────────────────────────────────────── */

  const [programmes, setProgrammes] = useState<PublicProgramme[] | null>(null);
  const [programmeError, setProgrammeError] = useState("");

  const [sessions, setSessions] = useState<PublicSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState("");

  /** Session-level payload: identity, semester list, programme document. */
  const [base, setBase] = useState<PublicSyllabusDetail | null>(null);
  const [baseError, setBaseError] = useState<LoadError | null>(null);

  /** Semester-level payload: subjects + semester document. */
  const [detail, setDetail] = useState<PublicSyllabusDetail | null>(null);
  const [detailError, setDetailError] = useState<LoadError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // One monotonic guard per data stream (see the file header, rule 2).
  const programmesGuard = useRef(createRequestGuard()).current;
  const sessionsGuard = useRef(createRequestGuard()).current;
  const baseGuard = useRef(createRequestGuard()).current;
  const detailGuard = useRef(createRequestGuard()).current;

  /* ── URL navigation ──────────────────────────────────────────── */

  const navigate = useCallback(
    (updates: Record<string, string | null>, mode: "push" | "replace") => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      const query = params.toString();
      const target = query ? `${pathname}?${query}` : pathname;
      if (mode === "push") router.push(target, { scroll: false });
      else router.replace(target, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  /* ── Loaders (each guarded — obsolete responses are discarded) ─ */

  const loadProgrammes = useCallback(async () => {
    const id = programmesGuard.next();
    setProgrammeError("");
    setProgrammes(null);

    const outcome = await fetchPublicProgrammes();
    if (!programmesGuard.isCurrent(id)) return;

    if (outcome.success && outcome.data) setProgrammes(outcome.data);
    else setProgrammeError(outcome.message);
  }, [programmesGuard]);

  const loadSessions = useCallback(async () => {
    const id = sessionsGuard.next();
    setSessions(null);
    setSessionsError("");
    if (!programmeParam) return;

    const outcome = await fetchPublicSessions(programmeParam);
    if (!sessionsGuard.isCurrent(id)) return;

    if (outcome.success && outcome.data) setSessions(outcome.data);
    else setSessionsError(outcome.message);
  }, [sessionsGuard, programmeParam]);

  const loadBase = useCallback(async () => {
    const id = baseGuard.next();
    setBase(null);
    setBaseError(null);
    if (!programmeParam || !sessionParam) return;

    const outcome = await fetchPublicSyllabus({
      programmeCode: programmeParam,
      academicSession: sessionParam,
    });
    if (!baseGuard.isCurrent(id)) return;

    if (outcome.success && outcome.data) setBase(outcome.data);
    else setBaseError(toLoadError(outcome));
  }, [baseGuard, programmeParam, sessionParam]);

  const loadDetail = useCallback(async () => {
    const id = detailGuard.next();
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    if (!programmeParam || !sessionParam || !semesterParam) return;

    setDetailLoading(true);
    const outcome = await fetchPublicSyllabus({
      programmeCode: programmeParam,
      academicSession: sessionParam,
      semester: semesterParam,
    });
    if (!detailGuard.isCurrent(id)) return;

    setDetailLoading(false);
    if (outcome.success && outcome.data) setDetail(outcome.data);
    else setDetailError(toLoadError(outcome));
  }, [detailGuard, programmeParam, sessionParam, semesterParam]);

  // The clear-then-fetch loaders set state synchronously on purpose: when the
  // URL changes (back/forward, auto-defaults) the previous selection's data
  // must disappear in the same commit, never one render later.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProgrammes();
  }, [loadProgrammes]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBase();
  }, [loadBase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDetail();
  }, [loadDetail]);

  /* ── Defaults: auto-select only when a single option exists ──── */

  useEffect(() => {
    if (programmes && programmes.length === 1 && !programmeParam) {
      // Orphan session/semester params without a programme are meaningless.
      navigate(
        {
          programme: programmes[0].programmeCode,
          session: null,
          semester: null,
        },
        "replace"
      );
    }
  }, [programmes, programmeParam, navigate]);

  useEffect(() => {
    if (programmeParam && sessions && sessions.length === 1 && !sessionParam) {
      navigate({ session: sessions[0].academicSession }, "replace");
    }
  }, [sessions, programmeParam, sessionParam, navigate]);

  /* ── Selection handlers — clear dependent state BEFORE navigating ─ */

  function handleProgrammeChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    // A different programme invalidates every session-derived value.
    setSessions(null);
    setSessionsError("");
    setBase(null);
    setBaseError(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    navigate(
      { programme: value || null, session: null, semester: null },
      "push"
    );
  }

  function handleSessionChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    // New session: drop the old session's semester list, subjects and documents
    // immediately, then fetch only the new session's data.
    setBase(null);
    setBaseError(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    navigate({ session: value || null, semester: null }, "push");
  }

  function handleSemesterChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    // Never keep the previous semester's subjects visible while loading.
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    navigate({ semester: value || null }, "push");
  }

  /* ── Select options ──────────────────────────────────────────── */    const semesterOptions = base?.semesters ?? [];
  const semesterPlaceholder = !programmeParam
    ? "Select a programme first"
    : !sessionParam
      ? "Select a session first"
      : baseError
        ? "Semesters unavailable"
        : "Loading semesters…";

  const sessionPlaceholder = sessionsError
    ? "Unable to load sessions"
    : !programmeParam
      ? "Select a programme first"
      : sessions === null
        ? "Loading sessions…"
        : "Select academic session";

  /* ── Rendering ───────────────────────────────────────────────── */

  function renderPdfCard(
    title: string,
    doc: { pdfUrl: string | null; pdfName: string | null } | null,
    fallbackName: string
  ) {
    if (!doc?.pdfUrl) return null;
    const downloadUrl = `${doc.pdfUrl}${doc.pdfUrl.includes("?") ? "&" : "?"}download=1`;

    return (
      <div className={styles.docCard}>
        <div className={styles.docIcon}>
          <FileText size={18} aria-hidden="true" />
        </div>
        <div className={styles.docInfo}>
          <p className={styles.docTitle}>{title}</p>
          <p className={styles.docMeta}>{doc.pdfName || fallbackName}</p>
        </div>
        <div className={styles.docActions}>
          <a
            className={styles.primaryLink}
            href={doc.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View PDF
          </a>
          <a className={styles.secondaryLink} href={downloadUrl}>
            Download
          </a>
        </div>
      </div>
    );
  }

  /** Optional per-subject links carried by the published syllabus document. */
  function renderSubjectLinks(
    subject: CurriculumSubject,
    doc: Map<string, DocumentSubjectLink>
  ) {
    const links = doc.get(subject.subjectCode);
    if (!links || (!links.syllabusUrl && !links.pdfUrl)) return null;

    return (
      <span className={styles.subjectLinks}>
        {links.syllabusUrl && (
          <a
            href={links.syllabusUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Syllabus
          </a>
        )}
        {links.pdfUrl && (
          <a href={links.pdfUrl} target="_blank" rel="noopener noreferrer">
            PDF
          </a>
        )}
      </span>
    );
  }

  function renderSubjectTable(
    list: CurriculumSubject[],
    docLinks: Map<string, DocumentSubjectLink>
  ) {
    return (
      <>
        <div className={styles.tableWrapper}>
          <table className={styles.subjectTable}>
            <thead>
              <tr>
                <th>Subject Code</th>
                <th>Subject Name</th>
                <th>Credits</th>
                <th>Assessment</th>
              </tr>
            </thead>
            <tbody>
              {list.map((subject) => (
                <tr key={subject.subjectCode}>
                  <td className={styles.monoCell}>{subject.subjectCode}</td>
                  <td className={styles.nameCell}>
                    {subject.subjectName}
                    {subject.category !== "CORE" && (
                      <span className={styles.categoryChip}>
                        {subjectCategoryLabel(subject.category)}
                      </span>
                    )}
                    {renderSubjectLinks(subject, docLinks)}
                  </td>
                  <td>{subject.credits}</td>
                  <td className={styles.assessmentCell}>
                    {formatAssessment(subject.assessment)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile (≤600px): the same subjects as record cards. */}
        <RecordList>
          {list.map((subject) => (
            <RecordCard
              key={subject.subjectCode}
              title={subject.subjectCode}
              subtitle={subject.subjectName}
            >
              <RecordField label="Credits">{subject.credits}</RecordField>
              <RecordField label="Type">
                {subjectTypeLabel(subject.subjectType)}
                {subject.category !== "CORE"
                  ? ` · ${subjectCategoryLabel(subject.category)}`
                  : ""}
              </RecordField>
              <RecordField label="Assessment">
                {formatAssessment(subject.assessment)}
              </RecordField>
            </RecordCard>
          ))}
        </RecordList>
      </>
    );
  }

  function renderSemesterContent() {
    if (!detail?.semester) return null;

    const { compulsory, groups } = partitionSubjects(detail.semester.subjects);
    // Per-subject links come from the published document for THIS session
    // (legacy records carry syllabusUrl/pdfUrl alongside the code).
    const docLinks = new Map<string, DocumentSubjectLink>(
      (detail.syllabus?.subjects ?? []).map((subject) => [
        subject.subjectCode,
        subject,
      ])
    );
    const semesterInactive =
      detail.semester.status === "INACTIVE" ||
      base?.programme.status === "INACTIVE";

    return (
      <>
        {detail.semester.status === "INACTIVE" &&
          base?.programme.status !== "INACTIVE" && (
            <p className={styles.note} role="note">
              This semester is inactive. Its subjects are not currently
              offered.
            </p>
          )}

        {renderPdfCard(
          `${semesterLabel(detail.semester)} Syllabus`,
          detail.syllabus,
          "Semester syllabus document"
        )}

        {detail.semester.subjects.length === 0 ? (
          <p className={styles.hint}>
            {semesterInactive
              ? "No subjects are offered under this selection right now."
              : "No subject information has been published for this semester yet."}
          </p>
        ) : (
          <>
            <h3 className={styles.sectionTitle}>Subjects</h3>

            {compulsory.length > 0 &&
              renderSubjectTable(compulsory, docLinks)}

            {/* Elective groups: alternatives, never extra compulsory papers. */}
            {groups.map((group) => (
              <div key={group.code} className={styles.electiveBlock}>
                <div className={styles.electiveHeader}>
                  <h4 className={styles.electiveTitle}>{group.code}</h4>
                  {group.selectionRule && (
                    <Badge variant="info">
                      {selectionRuleLabel(group.selectionRule)}
                    </Badge>
                  )}
                  <span className={styles.mutedInline}>
                    {group.options.length}{" "}
                    {group.options.length === 1 ? "option" : "options"} — choose
                    one, these are alternatives
                  </span>
                </div>
                {renderSubjectTable(group.options, docLinks)}
              </div>
            ))}
          </>
        )}
      </>
    );
  }

  function renderResults(): React.ReactNode {
    if (programmeError) {
      return (
        <ErrorState
          title="Unable to load programmes"
          description={programmeError}
          onRetry={loadProgrammes}
        />
      );
    }
    if (programmes === null) return <Loading label="Loading programmes…" />;
    if (programmes.length === 0) {
      return (
        <EmptyState
          icon={<BookOpen />}
          title="No programmes available"
          description="Syllabus information has not been published yet."
        />
      );
    }
    if (!programmeParam) {
      return (
        <EmptyState
          icon={<BookOpen />}
          title="Select a programme"
          description="Choose a programme, an academic session and a semester to view its syllabus."
        />
      );
    }

    if (!sessionParam) {
      if (sessionsError) {
        return (
          <ErrorState
            title="Unable to load academic sessions"
            description={sessionsError}
            onRetry={loadSessions}
          />
        );
      }
      if (sessions === null) {
        return <Loading label="Loading academic sessions…" />;
      }
      if (sessions.length === 0) {
        return (
          <EmptyState
            icon={<BookOpen />}
            title="No academic session available"
            description={`No syllabus information has been published for ${programmeParam} yet.`}
          />
        );
      }
      return (
        <EmptyState
          icon={<BookOpen />}
          title="Select an academic session"
          description="Choose an academic session to see the syllabus published for it."
        />
      );
    }

    if (!base) {
      if (baseError) {
        return baseError.kind === "empty" ? (
          <EmptyState
            icon={<FileText />}
            title="No syllabus found"
            description={baseError.message}
          />
        ) : (
          <ErrorState
            title="Unable to load the syllabus"
            description={baseError.message}
            onRetry={baseError.retryable ? loadBase : undefined}
          />
        );
      }
      return <Loading label="Loading syllabus…" />;
    }

    const selectedSemester = semesterParam
      ? (semesterOptions.find(
          (entry) => String(entry.semesterNumber) === semesterParam
        ) ?? null)
      : null;
    const structureInactive = base.programme.status === "INACTIVE";

    return (
      <>
        <div className={styles.resultHeader}>
          <div className={styles.resultIdentity}>
            <h2 className={styles.resultTitle}>
              {base.programme.programmeName}
            </h2>
            <p className={styles.resultMeta}>
              <span className={styles.metaChip}>
                {base.programme.programmeCode}
              </span>
              <span>
                Academic Session {base.programme.academicSession}
              </span>
              {semesterParam && (
                <span>
                  {selectedSemester
                    ? semesterLabel(selectedSemester)
                    : `Semester ${semesterParam}`}
                </span>
              )}
            </p>
          </div>
          {structureInactive && <Badge variant="neutral">Inactive</Badge>}
        </div>

        {structureInactive && (
          <p className={styles.note} role="note">
            This academic session is inactive. Its records are kept for
            reference and published documents remain available.
          </p>
        )}

        {renderPdfCard(
          "Official Programme Syllabus",
          base.programmeDocument,
          "Programme syllabus document"
        )}

        {base.legacyDocumentWithheld && (
          <p className={styles.note} role="note">
            Published syllabus documents for this programme are not yet linked
            to an academic session, so they cannot be shown for a specific
            session.
          </p>
        )}

        <div className={styles.semesterSection}>
          {!semesterParam ? (
            <p className={styles.hint}>
              Select a semester to view its syllabus document and subject list.
            </p>
          ) : detailError ? (
            detailError.kind === "empty" ? (
              <EmptyState
                icon={<FileText />}
                title="No syllabus found"
                description={detailError.message}
              />
            ) : (
              <ErrorState
                title="Unable to load the semester syllabus"
                description={detailError.message}
                onRetry={detailError.retryable ? loadDetail : undefined}
              />
            )
          ) : detailLoading || !detail ? (
            <Loading label="Loading semester syllabus…" />
          ) : (
            renderSemesterContent()
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <Card className={styles.selectorCard}>
        <CardHeader
          title="Select Programme & Session"
          subtitle="The selection is kept in the page URL, so it can be refreshed or shared."
        />
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <label htmlFor="syllabus-programme">Programme</label>
            <select
              id="syllabus-programme"
              className={styles.select}
              value={programmeParam}
              onChange={handleProgrammeChange}
              disabled={programmes === null}
            >
              {programmes === null ? (
                <option value="">
                  {programmeError
                    ? "Unable to load programmes"
                    : "Loading programmes…"}
                </option>
              ) : (
                <>
                  <option value="">Select programme</option>
                  {programmeParam &&
                    !programmes.some(
                      (entry) => entry.programmeCode === programmeParam
                    ) && <option value={programmeParam}>{programmeParam}</option>}
                  {programmes.map((entry) => (
                    <option
                      key={entry.programmeCode}
                      value={entry.programmeCode}
                    >
                      {entry.programmeName
                        ? `${entry.programmeCode} — ${entry.programmeName}`
                        : entry.programmeCode}
                    </option>
                  ))}
                </>
              )}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="syllabus-session">Academic Session</label>
            <select
              id="syllabus-session"
              className={styles.select}
              value={sessionParam}
              onChange={handleSessionChange}
              disabled={!programmeParam || sessions === null}
            >
              <option value="">{sessionPlaceholder}</option>
              {sessionParam &&
                sessions &&
                !sessions.some(
                  (entry) => entry.academicSession === sessionParam
                ) && <option value={sessionParam}>{sessionParam}</option>}
              {sessions?.map((entry) => (
                <option key={entry.academicSession} value={entry.academicSession}>
                  {entry.academicSession}
                  {entry.status === "INACTIVE" ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="syllabus-semester">Semester</label>
            <select
              id="syllabus-semester"
              className={styles.select}
              value={semesterParam}
              onChange={handleSemesterChange}
              disabled={!base}
            >
              <option value="">
                {base ? "Select semester" : semesterPlaceholder}
              </option>
              {base &&
                semesterParam &&
                !semesterOptions.some(
                  (entry) => String(entry.semesterNumber) === semesterParam
                ) && <option value={semesterParam}>Semester {semesterParam}</option>}
              {semesterOptions.map((entry) => (
                <option key={entry.semesterNumber} value={entry.semesterNumber}>
                  {semesterLabel(entry)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {sessionsError && (
          <p className={styles.formError} role="alert">
            {sessionsError}
          </p>
        )}
      </Card>

      <Card className={styles.resultCard}>{renderResults()}</Card>
    </>
  );
}
