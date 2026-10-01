/**
 * RecordList — mobile-only representation of an admin table row.
 *
 * The admin tables (Students, Results, Notices, Colleges, Enquiries) are
 * unusable at phone widths: fixed-min-width search controls, `nowrap`
 * cells and wide action columns force horizontal scrolling. Instead of
 * squeezing the table, each page renders a record card list from the
 * SAME fetched array and the two representations swap at the project's
 * existing 600px mobile breakpoint (see record-list.module.css).
 *
 * The list is `display: none` on desktop, so the desktop table markup is
 * untouched and still rendered exactly as before.
 *
 * Exports:
 *   RecordList  — <ul> wrapper for the cards
 *   RecordCard  — one record: header (identity + actions) + field rows
 *   RecordField — one "LABEL  value" row inside a card
 *
 * Accessibility: field rows use <dt>/<dd> pairs so the label/value
 * relationship is announced, and the list/card structure gives screen
 * readers a clear item count. `display: none` removes the hidden
 * representation from the accessibility tree entirely, so nothing is
 * announced twice.
 */
import styles from "./record-list.module.css";

interface RecordListProps {
  children: React.ReactNode;
}

export default function RecordList({ children }: RecordListProps) {
  return <ul className={styles.list}>{children}</ul>;
}

interface RecordCardProps {
  /** Primary identifier shown in the header (student name, notice title, …). */
  title: string;
  /** Secondary identifier (roll number, notice type, reference, …). */
  subtitle?: string;
  /** Compact row actions — the exact same handlers used by the table. */
  actions?: React.ReactNode;
  /** RecordField rows. */
  children: React.ReactNode;
}

export function RecordCard({ title, subtitle, actions, children }: RecordCardProps) {
  return (
    <li className={styles.card}>
      <div className={styles.head}>
        <div className={styles.identity}>
          <p className={styles.title}>{title}</p>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <dl className={styles.fields}>{children}</dl>
    </li>
  );
}

interface RecordFieldProps {
  label: string;
  /** May be plain text, a Badge, or any inline node. */
  children: React.ReactNode;
}

export function RecordField({ label, children }: RecordFieldProps) {
  return (
    <div className={styles.field}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}
