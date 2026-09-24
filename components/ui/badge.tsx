/**
 * Badge — colored label component for status/category display.
 *
 * Variants:
 *   success — green (PASS, published)
 *   warning — amber (COMPARTMENT, Academic)
 *   danger  — red (FAIL, Examination)
 *   info    — blue (Admission, Student, draft)
 *   neutral — gray (default)
 *
 * Used in admin tables for result status, notice category, and
 * content type badges.
 */
import styles from "./badge.module.css";

type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export default function Badge({ children, variant = "neutral", className = "" }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}
