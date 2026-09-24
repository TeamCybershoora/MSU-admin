/**
 * EmptyState — placeholder shown when a list or table has no data.
 *
 * Used by admin pages (students, results, notices, colleges, syllabus)
 * to display a friendly message with an optional icon when search results
 * are empty or no records exist yet.
 *
 * Props:
 *   icon      — optional Lucide icon element (e.g. <Users />)
 *   title     — short heading (e.g. "No students found")
 *   description — optional longer explanation
 */
import styles from "./empty-state.module.css";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
}

export default function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.desc}>{description}</p>}
    </div>
  );
}
