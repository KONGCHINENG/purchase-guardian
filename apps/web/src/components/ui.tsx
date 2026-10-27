import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");
export { cx };

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "paypal";

export function Button({
  variant = "primary",
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-brand text-white hover:bg-brand-strong dark:text-canvas",
    secondary: "bg-surface text-ink border border-line hover:bg-sunken",
    ghost: "text-ink-soft hover:bg-sunken hover:text-ink",
    danger: "bg-surface text-danger border border-line hover:bg-danger-tint",
    paypal: "bg-[#ffc439] text-[#111] hover:bg-[#f2b621]",
  };
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cx(
        "inline-flex h-10 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-55",
        styles[variant],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent", className)}
    />
  );
}

export function Card({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cx("rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]", className)}>{children}</div>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {error ? <span className="block text-xs text-danger">{error}</span> : hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-faint",
        "focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20",
        className,
      )}
    />
  );
}

type Tone = "neutral" | "brand" | "warn" | "danger" | "info";
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const tones: Record<Tone, string> = {
    neutral: "bg-sunken text-ink-soft",
    brand: "bg-brand-tint text-brand-strong",
    warn: "bg-warn-tint text-warn",
    danger: "bg-danger-tint text-danger",
    info: "bg-info-tint text-info",
  };
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>;
}

export function Alert({ tone = "danger", children }: { tone?: "danger" | "warn" | "info"; children: ReactNode }) {
  const tones = { danger: "bg-danger-tint text-danger", warn: "bg-warn-tint text-warn", info: "bg-info-tint text-info" };
  return (
    <div role="alert" className={cx("rounded-[10px] px-3.5 py-2.5 text-sm", tones[tone])}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-line px-6 py-12 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-1.5 text-sm text-ink-soft">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-soft">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ShieldMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 2.5 4 5.5v6.2c0 4.6 3.3 8.5 8 9.8 4.7-1.3 8-5.2 8-9.8V5.5l-8-3Z" fill="currentColor" opacity=".14" />
      <path d="M12 2.5 4 5.5v6.2c0 4.6 3.3 8.5 8 9.8 4.7-1.3 8-5.2 8-9.8V5.5l-8-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m8.5 12.2 2.4 2.4 4.7-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
