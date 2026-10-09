/**
 * Button — styled button component for the admin portal.
 *
 * Variants:
 *   primary  — solid teal (main actions)
 *   secondary — outlined (secondary actions)
 *   teal     — teal outline (accent)
 *   danger   — red (destructive actions like delete)
 *   ghost    — transparent (icon buttons, table actions)
 *
 * Features:
 *   loading  — shows a spinner and disables the button
 *   iconOnly — removes padding for icon-only usage (table action buttons)
 */
import styles from "./button.module.css";

type ButtonVariant = "primary" | "secondary" | "teal" | "danger" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconOnly?: boolean;
}

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  iconOnly = false,
  className = "",
  disabled,
  children,
  ...props
}: ButtonProps) {
  const classes = [
    styles.btn,
    styles[variant],
    size !== "md" && styles[size],
    iconOnly && styles.iconOnly,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}
