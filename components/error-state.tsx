/**
 * ErrorState — error placeholder with optional retry button.
 *
 * Used by admin pages when API calls fail (network error, 500, etc.).
 * Displays an icon, title, description, and a "Try Again" button
 * that calls onRetry to re-fetch data.
 *
 * Props:
 *   title       — heading (default: "Something went wrong")
 *   description — explanation (default: "An unexpected error occurred...")
 *   onRetry     — callback when "Try Again" is clicked
 */
import { AlertTriangle } from "lucide-react";
import styles from "./error-state.module.css";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

export default function ErrorState({
  title = "Something went wrong",
  description = "An unexpected error occurred. Please try again later.",
  onRetry,
}: ErrorStateProps) {
  return (
    <div className={styles.error}>
      <div className={styles.icon}>
        <AlertTriangle />
      </div>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.desc}>{description}</p>
      {onRetry && (
        <button type="button" className={styles.retryBtn} onClick={onRetry}>
          Try Again
        </button>
      )}
    </div>
  );
}
