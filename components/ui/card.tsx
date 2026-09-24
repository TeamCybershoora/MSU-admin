/**
 * Card — reusable container component for the admin portal.
 *
 * Provides a styled card wrapper used by all admin pages for sections,
 * tables, forms, and stat displays.
 *
 * Exports:
 *   Card       — main container with optional hover effect
 *   CardHeader — title + subtitle + optional action slot
 *   StatCard   — dashboard stat card with icon, label, and value
 */
import styles from "./card.module.css";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}

export default function Card({ children, className = "", hover = false }: CardProps) {
  return (
    <div className={`${styles.card} ${hover ? styles.cardHover : ""} ${className}`}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function CardHeader({ title, subtitle, actions }: CardHeaderProps) {
  return (
    <div className={styles.header}>
      <div>
        <h3 className={styles.title}>{title}</h3>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div>{actions}</div>}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  variant?: "teal" | "accent" | "muted" | "neutral";
  className?: string;
}

export function StatCard({ label, value, icon, variant = "teal", className = "" }: StatCardProps) {
  return (
    <div className={`${styles.card} ${styles.stat} ${className}`}>
      <div className={`${styles.statIcon} ${styles[`statIcon${variant.charAt(0).toUpperCase() + variant.slice(1)}`] ?? ''}`}>
        {icon}
      </div>
      <div className={styles.statContent}>
        <p className={styles.statLabel}>{label}</p>
        <p className={styles.statValue}>{value}</p>
      </div>
    </div>
  );
}
