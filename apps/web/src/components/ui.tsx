"use client";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";

export const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ button */

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "quiet";
  size?: "xs" | "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const base =
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium " +
    "transition-[background-color,border-color,color,box-shadow] duration-150 " +
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";
  const sizes = {
    xs: "h-7 px-2 text-xs",
    sm: "h-8 px-3 text-sm",
    md: "h-9.5 px-4 text-sm",
    lg: "h-11 px-5 text-[15px]",
  };
  const variants = {
    // The one thing on the screen that should be pressed. A hairline of
    // the darker red underneath keeps it from floating on white.
    primary:
      "bg-primary text-on-primary shadow-e1 hover:bg-primary-hover active:bg-primary-hover",
    secondary:
      "border border-line-strong bg-surface text-foreground shadow-e1 hover:bg-surface-muted",
    danger: "bg-danger text-on-danger shadow-e1 hover:brightness-110",
    ghost: "text-muted hover:bg-surface-muted hover:text-foreground",
    // For a row of actions inside a table, where a border per button
    // would draw a grid nobody asked for.
    quiet: "text-primary-ink hover:bg-primary-soft",
  };
  return (
    <button
      type={props.type ?? "button"}
      className={cx(base, sizes[size], variants[variant], className)}
      disabled={loading || props.disabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------- forms */

const CONTROL =
  "w-full rounded-md border border-line-strong bg-surface text-foreground " +
  "transition-[border-color,box-shadow] duration-150 " +
  "placeholder:text-muted-soft " +
  "hover:border-[var(--muted-soft)] " +
  "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted " +
  "aria-[invalid=true]:border-danger";

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  required?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-[13px] font-medium text-foreground"
      >
        {label}
        {required && (
          <span className="ml-1 text-danger" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[13px] leading-snug text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cx(CONTROL, "h-9.5 px-3 text-sm", className)}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={ref}
      className={cx(CONTROL, "min-h-24 px-3 py-2 text-sm", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(CONTROL, "h-9.5 px-2.5 text-sm", className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function TextField({
  label,
  hint,
  error,
  required,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      htmlFor={id}
      required={required}
    >
      <Input id={id} aria-invalid={error ? true : undefined} {...props} />
    </Field>
  );
}

/* ------------------------------------------------------------------- shell */

/**
 * The top of a page: what it is, what it is for, and what you can do
 * here.
 *
 * Every screen having the same first three centimetres is most of what
 * makes an application feel like one product rather than twenty. The
 * actions sit on the right at the same height as the title, which is
 * where a hand goes looking for them.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.01em]">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            {description}
          </p>
        )}
        {meta && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            {meta}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  footer,
  children,
  className,
  padding = "normal",
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /** `flush` for a card whose whole body is a table or a list. */
  padding?: "normal" | "tight" | "flush";
}) {
  const body = {
    normal: "px-5 py-4",
    tight: "px-4 py-3",
    flush: "",
  }[padding];
  return (
    <section
      className={cx(
        "overflow-hidden rounded-xl border border-line bg-surface shadow-e1",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-[13px] text-muted">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={body}>{children}</div>
      {footer && (
        <footer className="border-t border-line bg-surface-sunken px-5 py-3 text-sm">
          {footer}
        </footer>
      )}
    </section>
  );
}

/**
 * The strip above a table: filters on the left, actions on the right.
 *
 * Sunken rather than white, so a long table scrolling underneath does
 * not appear to run into the controls that filter it.
 */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface-sunken px-4 py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ status */

export function Alert({
  tone = "danger",
  title,
  children,
  actions,
}: {
  tone?: "danger" | "warning" | "success" | "info";
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const tones = {
    danger: "border-danger/30 bg-danger-soft text-danger",
    warning: "border-warning/30 bg-warning-soft text-warning",
    success: "border-success/30 bg-success-soft text-success",
    info: "border-line bg-surface-sunken text-foreground",
  };
  return (
    <div
      className={cx(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm",
        tones[tone],
      )}
      role="alert"
    >
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className={cx(title && "mt-0.5", "leading-relaxed")}>
          {children}
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/**
 * Status, in a word.
 *
 * `tone` takes either a semantic name or one of the status words this
 * system already uses, so a caller can pass the value straight through
 * without a lookup table of its own.
 */
const CHIP_TONES: Record<string, string> = {
  neutral: "bg-surface-muted text-muted",
  info: "bg-primary-soft text-primary-ink",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",

  ACTIVE: "bg-success-soft text-success",
  PAID: "bg-success-soft text-success",
  COMPLETED: "bg-success-soft text-success",
  POSTED: "bg-success-soft text-success",
  ISSUED: "bg-primary-soft text-primary-ink",
  OPEN: "bg-primary-soft text-primary-ink",
  DRAFT: "bg-surface-muted text-muted",
  INVITED: "bg-warning-soft text-warning",
  LOCKED: "bg-warning-soft text-warning",
  PARTIAL: "bg-warning-soft text-warning",
  SUSPENDED: "bg-warning-soft text-warning",
  DISABLED: "bg-surface-muted text-muted",
  INACTIVE: "bg-surface-muted text-muted",
  CANCELLED: "bg-surface-muted text-muted",
  VOID: "bg-danger-soft text-danger",
  VOIDED: "bg-danger-soft text-danger",
  NO_SHOW: "bg-danger-soft text-danger",
};

export function Chip({
  children,
  tone,
  dot = false,
}: {
  children: ReactNode;
  tone?: string;
  dot?: boolean;
}) {
  const key = tone ?? (typeof children === "string" ? children : "info");
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        CHIP_TONES[key] ?? CHIP_TONES["info"],
      )}
    >
      {dot && (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-current opacity-70"
        />
      )}
      {children}
    </span>
  );
}

/** One number, big, with what it is underneath. */
export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "warning" | "danger" | "success";
  className?: string;
}) {
  const accent = {
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  };
  return (
    <div className={cx("min-w-0", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
        {label}
      </p>
      <p
        className={cx(
          "mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums",
          tone && accent[tone],
        )}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 text-[13px] leading-snug text-muted">{hint}</p>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong bg-surface-sunken px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p>
      )}
      {actions && (
        <div className="mt-4 flex justify-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/** A grey block the shape of the thing that is coming. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cx("animate-pulse rounded bg-surface-muted", className)}
    />
  );
}

/* ------------------------------------------------------------------- tabs */

/**
 * A row of pills where exactly one is on.
 *
 * Distinct from `Tabs`: tabs switch between sections of a page, a
 * segmented control narrows what one section is showing. Using tabs for
 * a filter tells somebody the content below is a different place, and
 * they lose their bearings when it is not.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-1 rounded-full bg-surface-sunken p-1 ring-1 ring-line"
    >
      {options.map(([key, text]) => {
        const on = key === value;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(key)}
            className={cx(
              "rounded-full px-3 py-1.5 text-sm transition-colors",
              on
                ? "bg-surface font-medium text-foreground shadow-e1"
                : "text-muted hover:text-foreground",
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label = "Sections",
}: {
  tabs: Array<{ key: T; label: string; count?: number }>;
  value: T;
  onChange: (key: T) => void;
  label?: string;
}) {
  return (
    <nav
      className="-mb-px flex flex-wrap gap-0.5 border-b border-line"
      aria-label={label}
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            aria-current={active ? "page" : undefined}
            className={cx(
              "relative -mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm transition-colors",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted hover:border-line-strong hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cx(
                  "rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                  active
                    ? "bg-primary-soft text-primary-ink"
                    : "bg-surface-muted text-muted",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ overlay */

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-e3"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
          >
            Esc
          </Button>
        </header>
        <div className="scroll-slim flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && (
          <footer className="border-t border-line bg-surface-sunken px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  size = "md",
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className={cx(
          "relative my-8 w-full rounded-xl border border-line bg-surface p-5 shadow-e3 sm:my-0",
          widths[size],
        )}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted">{description}</p>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- misc */

export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
