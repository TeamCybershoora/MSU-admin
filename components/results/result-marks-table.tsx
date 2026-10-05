/**
 * ResultMarksTable — subject-wise marks table of the Statement of Marks.
 *
 * Renders the internals / externals / total / grade / credits / status for
 * every subject of the semester, plus a totals row. The status column shows the
 * subject's real status (Pass / Fail / Absent / Compartment) derived from the
 * stored fields; a compartment subject is also marked with a trailing asterisk
 * on the subject name, so the flag survives a black-and-white photocopy.
 *
 * Intentionally print-first: fixed column widths, no hover states, and
 * long subject names wrap instead of being clipped.
 */

import { subjectStatus, type SubjectStatus } from "@/lib/result-grading";
import type { StatementSubject } from "./types";
import styles from "./result-marks-table.module.css";

/** Document tone for a subject status, from the existing stored derivation. */
function statusClass(status: SubjectStatus): string {
  switch (status) {
    case "Pass":
      return styles.statusPass;
    case "Fail":
      return styles.statusFail;
    case "Absent":
      return styles.statusAbsent;
    default:
      return styles.compartment;
  }
}

interface ResultMarksTableProps {
  subjects: StatementSubject[];
  /** Sum of the subject totals; printed in the footer row. */
  totalMarks: number;
  /** Sum of the subject maxima; printed in the footer row. */
  maxTotalMarks: number;
}

export default function ResultMarksTable({
  subjects,
  totalMarks,
  maxTotalMarks,
}: ResultMarksTableProps) {
  const totalCredits = subjects.reduce((sum, subject) => sum + (subject.credits || 0), 0);

  return (
    <section className={styles.section}>
      {/* h3 keeps this sibling to the other section headings, leaving the
          Statement of Marks title as the document's only h2. */}
      <h3 className={styles.sectionTitle}>Subject-wise Marks</h3>

      <table className={styles.table}>
        <caption className={styles.caption}>Semester examination — subject-wise performance</caption>
        <thead>
          <tr>
            <th scope="col" className={styles.colIndex}>#</th>
            <th scope="col" className={styles.colCode}>Code</th>
            <th scope="col" className={styles.colName}>Subject</th>
            <th scope="col" className={styles.colNum}>Internal</th>
            <th scope="col" className={styles.colNum}>External</th>
            <th scope="col" className={styles.colNum}>Total</th>
            <th scope="col" className={styles.colNum}>Max</th>
            <th scope="col" className={styles.colNum}>Grade</th>
            <th scope="col" className={styles.colNum}>Credits</th>
            <th scope="col" className={styles.colStatus}>Status</th>
          </tr>
        </thead>
        <tbody>
          {subjects.map((subject, index) => (
            <tr key={`${subject.subjectCode}-${index}`} className={subject.isBacklog ? styles.backlogRow : undefined}>
              <td className={styles.colIndex}>{index + 1}</td>
              <td className={styles.colCode}>{subject.subjectCode}</td>
              <td className={styles.nameCell}>
                {subject.subjectName}
                {subject.isBacklog && <span className={styles.backlogMark} aria-hidden="true">*</span>}
              </td>
              {/* An absent candidate has no component marks; the statement must
                  print a dash rather than a misleading 0. */}
              <td className={styles.numCell}>{subject.isAbsent ? "—" : subject.internalMarks}</td>
              <td className={styles.numCell}>{subject.isAbsent ? "—" : subject.externalMarks}</td>
              <td className={styles.numCellStrong}>{subject.totalMarks}</td>
              <td className={styles.numCell}>{subject.maxMarks}</td>
              <td className={styles.numCellStrong}>{subject.grade || "—"}</td>
              <td className={styles.numCell}>{subject.credits}</td>
              {/* The stored/derived status (Pass / Fail / Absent / Compartment),
                  never a blanket em dash. */}
              <td className={styles.colStatus}>
                <span className={statusClass(subjectStatus(subject))}>
                  {subjectStatus(subject)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5} className={styles.totalLabel}>
              Total
            </td>
            <td className={styles.numCellStrong}>{totalMarks}</td>
            <td className={styles.numCellStrong}>{maxTotalMarks}</td>
            <td className={styles.numCell}>—</td>
            <td className={styles.numCellStrong}>{totalCredits}</td>
            <td className={styles.colStatus}>—</td>
          </tr>
        </tfoot>
      </table>

      {subjects.some((subject) => subject.isBacklog) && (
        <p className={styles.footnote}>
          <span aria-hidden="true">*</span> Compartment subject — to be cleared in the next
          supplementary examination.
        </p>
      )}
    </section>
  );
}
