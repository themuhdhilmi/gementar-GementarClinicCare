'use client';

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from 'react';
import { useId } from 'react';

const cx = (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' ');

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55';
  const sizes = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm' };
  const variants = {
    primary: 'bg-primary text-on-primary hover:bg-primary-hover',
    secondary: 'border border-line bg-surface text-foreground hover:bg-surface-muted',
    danger: 'bg-danger text-on-danger hover:opacity-90',
    ghost: 'text-muted hover:bg-surface-muted hover:text-foreground',
  };
  return (
    <button
      className={cx(base, sizes[size], variants[variant], className)}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : hint ? (
        <p className="text-sm text-muted">{hint}</p>
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
      className={cx(
        'h-10 w-full rounded-md border border-line bg-surface px-3 text-base',
        'placeholder:text-muted disabled:bg-surface-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'h-10 w-full rounded-md border border-line bg-surface px-2 text-sm',
        className,
      )}
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
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <Input id={id} aria-invalid={error ? true : undefined} {...props} />
    </Field>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Alert({
  tone = 'danger',
  title,
  children,
}: {
  tone?: 'danger' | 'warning' | 'success' | 'info';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    danger: 'border-danger/40 bg-danger-soft text-danger',
    warning: 'border-warning/40 bg-warning-soft text-warning',
    success: 'border-success/40 bg-success-soft text-success',
    info: 'border-line bg-surface-muted text-foreground',
  };
  return (
    <div className={cx('rounded-md border px-3 py-2.5 text-sm', tones[tone])} role="alert">
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? 'mt-0.5' : undefined}>{children}</div>
    </div>
  );
}

const CHIP_TONES: Record<string, string> = {
  ACTIVE: 'bg-success-soft text-success',
  INVITED: 'bg-warning-soft text-warning',
  LOCKED: 'bg-warning-soft text-warning',
  DISABLED: 'bg-surface-muted text-muted',
  INACTIVE: 'bg-surface-muted text-muted',
};

export function Chip({ children, tone }: { children: string; tone?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        CHIP_TONES[tone ?? children] ?? 'bg-primary-soft text-primary',
      )}
    >
      {children}
    </span>
  );
}

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
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            Esc
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/35" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-md rounded-lg border border-line bg-surface p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line px-4 py-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
