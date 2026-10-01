/**
 * ResultDocument — the official MSU "Statement of Marks" (semester result).
 *
 * This is a PRINTED UNIVERSITY DOCUMENT, not a dashboard: one fixed A4 sheet
 * (210 x 297 mm) framed by the ornamental border, and every figure is rendered
 * as part of that document — label/value rows, ruled tables, small formal
 * notes. There are deliberately no statistic cards, no rounded panels, no
 * shadows, no gradients and no hover affordances anywhere in here.
 *
 * Structure (matches the supplied statement):
 *
 *   ResultDocument
 *   ├── OrnamentalFrame (four-sided border tiled from public/border.png)
 *   └── ResultContent
 *       ├── Header               crest · university identity · optional QR
 *       ├── Title block           STATEMENT OF MARKS · examination line
 *       ├── CandidateDetails      roll / enrolment / name / course / …
 *       ├── ResultMarksTable      subject-wise marks + totals
 *       ├── Semester summary      previous semesters (headline rows only) + current
 *       ├── Academic summary      total / % / credits / SGPA / CGPA / grade
 *       ├── GradeScale            grade legend
 *       ├── Notes                 computer-generated document notice
 *       └── Footer                print time · statement reference
 *
 * Design rules honoured by this component:
 * - The border surrounds the WHOLE document, never individual sections, and
 *   the content is padded clear of it (`--msu-band` + gutter). Every section
 *   therefore shares one left/right content boundary and one vertical rhythm.
 * - The watermark is ALWAYS the university crest image — never text. It is
 *   centred, sits behind the content (content z-index 1 > watermark 0 > paper),
 *   is non-interactive, keeps the crest's own proportions, and is faint enough
 *   that no mark, grade or candidate detail is obscured.
 * - The QR block is strictly optional: when `qrCodeSrc` is absent nothing is
 *   rendered for it at all — no container, no placeholder, no broken image.
 *   The header is a 1fr / auto / 1fr grid, so the university identity stays
 *   optically centred whether or not the QR cell exists.
 * - Nothing here reads the database or the environment: the component is pure
 *   and derives the semester summary from the data it is handed.
 *
 * NOTE (final semester): `totalSemesters` is not stored anywhere yet, so it is
 * an explicit prop. When `totalSemesters` is supplied and equals the student's
 * current semester the document shows the entry point to the Full Degree
 * Result — a separate document (see ResultDocumentProps.onViewDegreeResult).
 * Semester VI is never hard-coded anywhere in this file.
 */

import OrnamentalFrame from "./ornamental-frame";
import ResultMarksTable from "./result-marks-table";
import type { GradeScaleRow, PreviousSemester, StatementOfMarks } from "./types";
import styles from "./result-document.module.css";

const UNIVERSITY_NAME = "MAA SHAKUMBHARI UNIVERSITY";
const UNIVERSITY_PLACE = "Saharanpur, Uttar Pradesh, India";

/**
 * The university crest.
 *
 * `app/favicon.ico` is the only MSU crest asset in the project; the App Router
 * metadata convention serves it at `/favicon.ico`. The SAME asset is used for
 * both the header crest and the document watermark, as the statement requires.
 */
const UNIVERSITY_LOGO_SRC = "/favicon.ico";

/**
 * Default 10-point grade legend.
 *
 * Override with the `gradeScale` prop once the examination ordinance is
 * confirmed — the component never assumes these are the official bands.
 */
const DEFAULT_GRADE_SCALE: GradeScaleRow[] = [
  { grade: "O", gradePoint: 10, range: "90 – 100", description: "Outstanding" },
  { grade: "A+", gradePoint: 9, range: "80 – 89", description: "Excellent" },
  { grade: "A", gradePoint: 8, range: "70 – 79", description: "Very good" },
  { grade: "B+", gradePoint: 7, range: "60 – 69", description: "Good" },
  { grade: "B", gradePoint: 6, range: "55 – 59", description: "Above average" },
  { grade: "C", gradePoint: 5, range: "50 – 54", description: "Average" },
  { grade: "P", gradePoint: 4, range: "40 – 49", description: "Pass" },
  { grade: "F", gradePoint: 0, range: "Below 40", description: "Fail" },
];

const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

/**
 * Read a semester number out of the free-text `student.semester` field
 * ("Semester IV", "4th Semester", "IV" …). Returns null when it cannot tell,
 * in which case no final-semester claim is made.
 */
function parseSemesterNumber(semester: string): number | null {
  if (!semester) return null;

  const digits = semester.match(/\d+/);
  if (digits) return Number(digits[0]);

  const roman = semester.toUpperCase().match(/\b[IVXLC]+\b/);
  if (!roman) return null;

  const value = roman[0];
  let total = 0;
  for (let i = 0; i < value.length; i += 1) {
    const current = ROMAN_VALUES[value[i]] ?? 0;
    const next = ROMAN_VALUES[value[i + 1]] ?? 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

/** Split a list into two halves (used to lay the grade legend out in 2 columns). */
function splitInHalf<T>(rows: T[]): [T[], T[]] {
  const middle = Math.ceil(rows.length / 2);
  return [rows.slice(0, middle), rows.slice(middle)];
}

/** Letter grade for a grade point, read from the supplied legend. */
function gradeForPoint(point: number, scale: GradeScaleRow[]): string {
  let best: GradeScaleRow | null = null;
  let bestPoint = -Infinity;
  for (const row of scale) {
    const rowPoint = Number(row.gradePoint);
    if (!Number.isFinite(rowPoint)) continue;
    if (rowPoint <= point && rowPoint > bestPoint) {
      best = row;
      bestPoint = rowPoint;
    }
  }
  return best ? best.grade : "—";
}

function toDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: Date | string | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
}

function formatDateTime(value: Date | string | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return `${date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })}, ${date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Official-looking tone for a result status, used on plain document text. */
function statusTone(status: string, styles: Record<string, string>): string {
  if (status === "PASS") return styles.statusPass;
  if (status === "FAIL") return styles.statusFail;
  return styles.statusCompartment;
}

export interface ResultDocumentProps {
  data: StatementOfMarks;
  /** Optional QR image URL. Omit to print the statement without a QR block. */
  qrCodeSrc?: string;
  /**
   * University crest URL. Defaults to the project crest (`/favicon.ico`), which
   * is also the watermark, so passing nothing still prints the real branding.
   */
  logoSrc?: string;
  /**
   * Optional watermark override. Defaults to the header crest — the watermark
   * is always an image; the document never falls back to a text watermark.
   */
  watermarkSrc?: string;
  /**
   * Headline figures for earlier semesters (no subject-wise marks — those
   * belong to their own statement).
   */
  previousSemesters?: PreviousSemester[];
  /** Total semesters of the programme, when known. Enables the final check. */
  totalSemesters?: number;
  /** Grade legend. Defaults to a 10-point scale. */
  gradeScale?: GradeScaleRow[];
  /** Print time shown in the footer. Defaults to the render time. */
  printedAt?: Date | string;
  /** Statement reference printed in the footer. */
  statementNumber?: string;
  /**
   * Called when the admin opens the Full Degree Result. Only ever rendered
   * when the current semester is the programme's final semester.
   */
  onViewDegreeResult?: () => void;
  className?: string;
}

export default function ResultDocument({
  data,
  qrCodeSrc,
  logoSrc = UNIVERSITY_LOGO_SRC,
  watermarkSrc,
  previousSemesters = [],
  totalSemesters,
  gradeScale = DEFAULT_GRADE_SCALE,
  printedAt,
  statementNumber,
  onViewDegreeResult,
  className = "",
}: ResultDocumentProps) {
  const { student, subjects, totalMarks, maxTotalMarks, percentage, cgpa, resultStatus } = data;

  /* ── Derived semester summary ─────────────────────────────────── */

  const totalCredits = subjects.reduce((sum, subject) => sum + (Number(subject.credits) || 0), 0);
  const weightedPoints = subjects.reduce(
    (sum, subject) => sum + (Number(subject.gradePoint) || 0) * (Number(subject.credits) || 0),
    0
  );
  const sgpa = totalCredits > 0 ? weightedPoints / totalCredits : null;
  const sgpaLabel = sgpa === null ? "—" : sgpa.toFixed(2);
  const gradeValue = sgpa === null ? "—" : gradeForPoint(sgpa, gradeScale);

  const currentSemesterNumber = parseSemesterNumber(student.semester);
  const isFinalSemester =
    totalSemesters !== undefined &&
    currentSemesterNumber !== null &&
    currentSemesterNumber >= totalSemesters;

  /** The watermark is the crest itself — never a typographic substitute. */
  const watermarkImage = watermarkSrc ?? logoSrc;

  /*
   * Candidate details, printed as aligned label/value rows (a printed record,
   * not a web form). Laid out over two columns so ten fields stay compact.
   */
  const candidateRows: { label: string; value?: string }[] = [
    { label: "Roll Number", value: student.rollNumber },
    { label: "Enrolment Number", value: student.enrollmentNumber },
    { label: "Candidate's Name", value: student.name },
    { label: "Father's Name", value: student.fatherName },
    { label: "Mother's Name", value: student.motherName },
    { label: "Gender", value: student.gender },
    { label: "Course / Programme", value: student.course },
    { label: "Semester", value: student.semester },
    { label: "Examination Session", value: student.academicSession },
    { label: "College", value: student.collegeName },
  ];

  /* Headline figures — rendered as one formal table, never as dashboard cards. */
  const academicFigures: { label: string; value: string }[] = [
    { label: "Total Marks", value: `${totalMarks} / ${maxTotalMarks}` },
    { label: "Percentage", value: `${percentage}%` },
    { label: "Credits Earned", value: String(totalCredits) },
    { label: "SGPA", value: sgpaLabel },
    { label: "Cumulative CGPA", value: cgpa && cgpa.trim() ? cgpa : "—" },
    { label: "Grade", value: gradeValue },
  ];

  return (
    <article className={`${styles.document} ${className}`}>
      <OrnamentalFrame className={styles.frame}>
        {/* Watermark — inside the frame, behind the content, never over it. */}
        {watermarkImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.watermark}
            src={watermarkImage}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        )}

        <div className={styles.content}>
          {/* ── Header: crest · university identity · optional QR ── */}
          <header className={styles.header}>
            <div className={styles.identity}>
              {logoSrc && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.logo} src={logoSrc} alt="" draggable={false} />
              )}
              <h1 className={styles.university}>{UNIVERSITY_NAME}</h1>
              <p className={styles.place}>{UNIVERSITY_PLACE}</p>
            </div>

            {/*
              Optional QR cell. Kept out of the DOM entirely when no QR is
              supplied, so no empty container or reserved blank block is ever
              shown; the identity simply stays centred in the middle column.
            */}
            {qrCodeSrc && (
              <div className={styles.qrCell}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.qr} src={qrCodeSrc} alt="Result verification code" />
                <span className={styles.qrLabel}>Scan to verify</span>
              </div>
            )}
          </header>

          <div className={styles.headerRule} aria-hidden="true" />

          {/* ── Document title ─────────────────────────────────── */}
          <div className={styles.titleBlock}>
            <h2 className={styles.docTitle}>Statement of Marks</h2>
            <span className={styles.titleRule} aria-hidden="true" />
            <p className={styles.docSubtitle}>
              {student.semester} Examination
              {student.course ? ` · ${student.course}` : ""}
              {student.academicSession ? ` · Academic Session ${student.academicSession}` : ""}
            </p>
          </div>

          {/* ── Candidate details ──────────────────────────────── */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Candidate Details</h3>
            <dl className={styles.details}>
              {candidateRows.map((row) => (
                <div className={styles.detailsRow} key={row.label}>
                  <dt className={styles.detailsLabel}>{row.label}</dt>
                  <dd className={styles.detailsValue}>
                    {row.value && row.value.trim() ? row.value : "—"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* ── Subject-wise marks ─────────────────────────────── */}
          <ResultMarksTable
            subjects={subjects}
            totalMarks={totalMarks}
            maxTotalMarks={maxTotalMarks}
          />

          {/* ── Semester summary (previous semesters: headline only) ── */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Semester Summary</h3>

            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th scope="col">Semester</th>
                  <th scope="col" className={styles.numCell}>
                    Credits
                  </th>
                  <th scope="col" className={styles.numCell}>
                    SGPA
                  </th>
                  <th scope="col" className={styles.numCell}>
                    Cumulative CGPA
                  </th>
                  <th scope="col" className={styles.numCell}>
                    Result
                  </th>
                </tr>
              </thead>
              <tbody>
                {previousSemesters.map((previous) => (
                  <tr key={previous.semester}>
                    <td>{previous.semester}</td>
                    <td className={styles.numCell}>{previous.credits}</td>
                    <td className={styles.numCell}>{previous.sgpa}</td>
                    <td className={styles.numCell}>{previous.cgpa ?? "—"}</td>
                    <td className={`${styles.numCell} ${styles.statusCell}`}>{previous.status}</td>
                  </tr>
                ))}
                <tr className={styles.currentRow}>
                  <td>{student.semester}</td>
                  <td className={styles.numCell}>{totalCredits}</td>
                  <td className={styles.numCell}>{sgpaLabel}</td>
                  <td className={styles.numCell}>{cgpa && cgpa.trim() ? cgpa : "—"}</td>
                  <td className={`${styles.numCell} ${statusTone(resultStatus, styles)}`}>
                    {resultStatus}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* ── Academic summary (one formal table, not cards) ──── */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Academic Summary</h3>
            <table className={`${styles.dataTable} ${styles.academicTable}`}>
              <thead>
                <tr>
                  {academicFigures.map((figure) => (
                    <th scope="col" key={figure.label}>
                      {figure.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {academicFigures.map((figure) => (
                    <td key={figure.label}>{figure.value}</td>
                  ))}
                </tr>
              </tbody>
            </table>

            {data.remarks && (
              <p className={styles.remarks}>
                <span className={styles.remarksLabel}>Remarks:</span> {data.remarks}
              </p>
            )}
          </section>

          {/* ── Grade scale ────────────────────────────────────── */}
          {/*
            Rendered as two side-by-side legends: the legend is reference
            material, so halving its height keeps the whole statement on one
            A4 sheet even when the marks table runs long.
          */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Grade Scale</h3>
            <div className={styles.gradeColumns}>
              {splitInHalf(gradeScale).map((half, halfIndex) => (
                <table className={`${styles.dataTable} ${styles.gradeTable}`} key={halfIndex}>
                  <thead>
                    <tr>
                      <th scope="col">Grade</th>
                      <th scope="col" className={styles.numCell}>
                        Value
                      </th>
                      <th scope="col" className={styles.numCell}>
                        Marks Range (%)
                      </th>
                      <th scope="col">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {half.map((row) => (
                      <tr key={`${row.grade}-${row.gradePoint}`}>
                        <td className={styles.gradeCell}>{row.grade}</td>
                        <td className={styles.numCell}>{row.gradePoint}</td>
                        <td className={styles.numCell}>{row.range}</td>
                        <td>{row.description ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </div>
          </section>

          {/*
            Closing block — the disclaimer and footer are pinned together to
            the bottom of the sheet, so however long the marks table runs the
            document still closes with a proper formal footer.
          */}
          <div className={styles.closing}>
            {/* ── Notes / disclaimer ───────────────────────────── */}
            <section className={styles.notes}>
              <p>
                This is a computer-generated Statement of Marks issued by {UNIVERSITY_NAME},{" "}
                {UNIVERSITY_PLACE}. It does not require a physical signature, and any alteration
                renders it void. Result declared on{" "}
                <strong>{formatDate(data.declaredDate)}</strong>.
                {qrCodeSrc ? " Scan the QR code to verify this statement." : ""}
              </p>
            </section>

            {/* ── Footer ───────────────────────────────────────── */}
            <footer className={styles.footer}>
              <span className={styles.footerGroup}>
                <span>Printed on {formatDateTime(printedAt ?? new Date())}</span>
                {statementNumber && <span>Reference: {statementNumber}</span>}
              </span>
              <span className={styles.footerGroup}>
                {isFinalSemester && onViewDegreeResult && (
                  <button
                    type="button"
                    className={styles.degreeButton}
                    onClick={onViewDegreeResult}
                    title="Final semester — the consolidated degree statement is available"
                  >
                    View Full Degree Result
                  </button>
                )}
                <span className={styles.footerNote}>
                  {UNIVERSITY_NAME} · Statement of Marks
                </span>
              </span>
            </footer>
          </div>
        </div>
      </OrnamentalFrame>
    </article>
  );
}
