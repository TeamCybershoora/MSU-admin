"use client";

/**
 * SearchableSelect — an accessible, type-to-filter combobox for the admin UI.
 *
 * WHY IT EXISTS:
 * A native <select> cannot be typed into, so a long list of programme/academic
 * session combinations has to be scanned by eye. This control lets the
 * administrator type a code or name, filters the real options and only ever
 * commits a value that corresponds to an actual option (typed text alone is
 * never a value — `onChange` fires only when an option is chosen or cleared).
 *
 * MODAL-SAFE RENDERING:
 * The option list is rendered through a portal on document.body and positioned
 * with viewport (fixed) coordinates, so it is never clipped by a modal's
 * `overflow: hidden` or by a scrolling form body, and stays visible while the
 * administrator searches.
 *
 * ACCESSIBILITY:
 * Implements the ARIA combobox + listbox pattern: aria-expanded, aria-controls,
 * aria-activedescendant, aria-autocomplete, role=option with aria-selected,
 * labelled input, Escape closes the list (and does not close the surrounding
 * modal), and Up/Down/Enter/Home/End are supported.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import styles from "./searchable-select.module.css";

/** One selectable option. `label` is primary, `description` secondary. */
export interface SearchableOption {
  value: string;
  label: string;
  description?: string;
}

export interface SearchableSelectProps {
  /** Input id — the visible <label htmlFor> points at it. */
  id: string;
  label: string;
  /** Selected option value; "" means nothing selected. */
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Message when the list is empty and the admin has typed a query. */
  noResultsMessage?: string;
  /** Message when there are no options at all (e.g. choose a programme first). */
  emptyMessage?: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  disabled?: boolean;
  required?: boolean;
  /** Show a clear/reset button when a value is selected (default true). */
  clearable?: boolean;
  hint?: string;
  /**
   * An EXPLICIT create action rendered at the foot of the option list, e.g.
   * "+ Add New Programme". It is only ever an affordance: the option list still
   * contains only real values, and typed text never becomes a value by itself.
   *
   * By default it is shown only when nothing matches (so it appears exactly when
   * the administrator is searching for something that does not exist yet); set
   * `alwaysShow` to keep it visible beside real options. The action receives the
   * current search text so the create flow can prefill what was typed.
   */
  footerAction?: {
    label: string;
    onClick: (query: string) => void;
    alwaysShow?: boolean;
  };
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  openUp: boolean;
}

export default function SearchableSelect({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Type to search…",
  noResultsMessage = "No matching options.",
  emptyMessage = "No options available.",
  loading = false,
  error = "",
  onRetry,
  disabled = false,
  required = false,
  clearable = true,
  hint,
  footerAction,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-listbox`;

  useEffect(() => {
    // Portal target exists only in the browser; the list never opens during SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""}`
        .toLowerCase()
        .includes(needle)
    );
  }, [options, query]);

  const optionId = useCallback(
    (optionValue: string) =>
      `${listId}-opt-${optionValue.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    [listId]
  );

  // The footer create action joins the keyboard navigation as one extra,
  // non-option item at the end — so it is reachable with Arrow/Home/End/Enter
  // exactly like a real option, without ever masquerading as one.
  const footerId = `${listId}-create`;
  const showFooter =
    !!footerAction && !loading && !error && (footerAction.alwaysShow || filtered.length === 0);
  const navigableCount = filtered.length + (showFooter ? 1 : 0);
  const footerActive = showFooter && activeIndex === filtered.length;

  const place = useCallback(() => {
    const el = controlRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gutter = 12;
    const spaceBelow = window.innerHeight - rect.bottom - gutter;
    const spaceAbove = rect.top - gutter;
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const available = Math.max(160, Math.min(320, openUp ? spaceAbove : spaceBelow));
    setPosition({
      left: rect.left,
      top: openUp ? rect.top - 6 : rect.bottom + 6,
      width: rect.width,
      maxHeight: available,
      openUp,
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }, []);

  // Position after mount; the menu is only rendered once a position exists, so
  // there is no unpositioned flash. useEffect (not useLayoutEffect) avoids a
  // server-render warning in this client component.
  useEffect(() => {
    if (!open) return;
    place();
    const onReposition = () => place();
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, place]);

  // Close on a click outside the control or the (portaled) menu.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  // Keep the active option visible while navigating with the keyboard.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const active = filtered[activeIndex];
    if (active) {
      document
        .getElementById(optionId(active.value))
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (footerActive) {
      document.getElementById(footerId)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeIndex, filtered, optionId, footerActive, footerId]);

  function openMenu() {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setActiveIndex(options.length > 0 || footerAction ? 0 : -1);
  }

  function runFooterAction() {
    if (!footerAction) return;
    const pendingQuery = query;
    close();
    footerAction.onClick(pendingQuery);
  }

  function selectOption(option: SearchableOption) {
    onChange(option.value);
    close();
    inputRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          openMenu();
          return;
        }
        setActiveIndex((index) =>
          navigableCount === 0 ? -1 : (index + 1) % navigableCount
        );
        return;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          openMenu();
          return;
        }
        setActiveIndex((index) =>
          navigableCount === 0
            ? -1
            : (index - 1 + navigableCount) % navigableCount
        );
        return;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveIndex(navigableCount > 0 ? 0 : -1);
        }
        return;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveIndex(navigableCount - 1);
        }
        return;
      case "Enter":
        if (open) {
          // Never let Enter inside an open combobox submit the surrounding form.
          event.preventDefault();
          const active = filtered[activeIndex];
          if (active) selectOption(active);
          else if (footerActive) runFooterAction();
        }
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          // Stop the surrounding modal's document-level Escape handler from
          // also closing the dialog.
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation?.();
          close();
        }
        return;
      case "Tab":
        if (open) close();
        return;
      default:
        return;
    }
  }

  const showClear = clearable && !!value && !disabled;
  const inputValue = open ? query : selected?.label ?? "";
  const inputPlaceholder = open
    ? selected?.label ?? searchPlaceholder
    : placeholder;

  const menu =
    open && mounted && position
      ? createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className={styles.menu}
            style={{
              left: position.left,
              width: position.width,
              top: position.top,
              maxHeight: position.maxHeight,
              transform: position.openUp ? "translateY(-100%)" : undefined,
            }}
          >
            {loading ? (
              <div className={styles.menuState}>
                <Loader2 size={15} className={styles.spin} />
                <span>Loading…</span>
              </div>
            ) : error ? (
              <div className={styles.menuState}>
                <span className={styles.menuError}>{error}</span>
                {onRetry && (
                  <button
                    type="button"
                    className={styles.retryBtn}
                    onClick={onRetry}
                  >
                    <RefreshCw size={13} /> Retry
                  </button>
                )}
              </div>
            ) : options.length === 0 ? (
              <div className={styles.menuState}>{emptyMessage}</div>
            ) : filtered.length === 0 ? (
              <div className={styles.menuState}>{noResultsMessage}</div>
            ) : (
              filtered.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <button
                    type="button"
                    key={option.value}
                    id={optionId(option.value)}
                    role="option"
                    aria-selected={isSelected}
                    className={`${styles.option} ${
                      index === activeIndex ? styles.optionActive : ""
                    } ${isSelected ? styles.optionSelected : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    // Keep focus on the input so typing/navigation continues.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectOption(option)}
                  >
                    <span className={styles.optionText}>
                      <span className={styles.optionLabel}>{option.label}</span>
                      {option.description && (
                        <span className={styles.optionDesc}>
                          {option.description}
                        </span>
                      )}
                    </span>
                    {isSelected && <Check size={15} />}
                  </button>
                );
              })
            )}

            {showFooter && footerAction && (
              <div className={styles.menuFooter}>
                <button
                  type="button"
                  id={footerId}
                  className={`${styles.footerBtn} ${
                    footerActive ? styles.footerBtnActive : ""
                  }`}
                  // Keep focus on the input so the surrounding form is untouched.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={runFooterAction}
                >
                  <Plus size={15} />
                  {footerAction.label}
                </button>
              </div>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div className={styles.field} ref={rootRef}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {required && <span className={styles.required}> *</span>}
      </label>

      <div
        ref={controlRef}
        className={`${styles.control} ${open ? styles.controlOpen : ""} ${
          disabled ? styles.controlDisabled : ""
        }`}
      >
        <Search size={15} className={styles.searchIcon} />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          className={styles.input}
          value={inputValue}
          placeholder={inputPlaceholder}
          disabled={disabled}
          required={required && !value}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex >= 0
              ? filtered[activeIndex]
                ? optionId(filtered[activeIndex].value)
                : footerActive
                  ? footerId
                  : undefined
              : undefined
          }
          autoComplete="off"
          onChange={(event) => {
            if (!open) setOpen(true);
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onFocus={openMenu}
          onKeyDown={handleKeyDown}
        />

        {showClear && (
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={`Clear ${label}`}
            onClick={() => {
              onChange("");
              setQuery("");
              setActiveIndex(-1);
              inputRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}

        <button
          type="button"
          className={styles.iconBtn}
          aria-label={open ? `Hide ${label} options` : `Show ${label} options`}
          tabIndex={-1}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) close();
            else {
              openMenu();
              inputRef.current?.focus();
            }
          }}
        >
          <ChevronDown
            size={16}
            className={open ? styles.chevronOpen : undefined}
          />
        </button>
      </div>

      {hint && <span className={styles.hint}>{hint}</span>}

      {menu}
    </div>
  );
}
