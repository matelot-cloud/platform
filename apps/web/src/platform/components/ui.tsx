import type { ReactNode } from "react";
import Badge from "@/components/ui/badge/Badge";
import { cn } from "@/utils";
import type { Criticality } from "../api/types";
import { humanize } from "../format";

/** Card in the template's style: rounded, bordered, with an optional header row. */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding (for tables). */
  flush?: boolean;
}) {
  return (
    <div className={cn("rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-6 py-4">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-base font-medium leading-6 text-gray-800 dark:text-white/90">{title}</h3>}
            {description && <p className="mt-0.5 text-sm leading-5 text-gray-500 dark:text-gray-400">{description}</p>}
          </div>
          {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">{actions}</div>}
        </div>
      )}
      <div className={cn(title || actions ? "border-t border-gray-100 dark:border-gray-800" : "", flush ? "" : "p-4 sm:p-6")}>{children}</div>
    </div>
  );
}

export function StatCard({ title, value, icon, caption }: { title: string; value: ReactNode; icon: ReactNode; caption?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 dark:border-gray-800 dark:bg-white/3">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800">
        <span className="size-6 text-gray-800 dark:text-white/90 [&>svg]:size-6">{icon}</span>
      </div>
      <div className="mt-5">
        <span className="text-sm text-gray-500 dark:text-gray-400">{title}</span>
        <h4 className="mt-2 text-title-sm font-bold text-gray-800 dark:text-white/90">{value}</h4>
        {caption && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{caption}</p>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-8 text-center">
      <p className="text-sm font-medium text-gray-800 dark:text-white/90">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">{children}</p>}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-xl border border-error-500/30 bg-error-50 px-4 py-3 text-sm text-error-600 dark:border-error-500/30 dark:bg-error-500/15 dark:text-error-500">
      {message}
    </div>
  );
}

const CRITICALITY_COLOR: Record<Criticality, "success" | "primary" | "warning" | "error"> = {
  LOW: "success",
  MEDIUM: "primary",
  HIGH: "warning",
  CRITICAL: "error",
};

export function CriticalityBadge({ value }: { value: Criticality }) {
  return (
    <Badge size="sm" color={CRITICALITY_COLOR[value]}>
      {humanize(value)}
    </Badge>
  );
}

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge size="sm" color="primary">
      {humanize(role)}
    </Badge>
  );
}

/* Table styling in the template's vocabulary */
/* One button system for the whole app: 40 px tall, same radius, same focus ring. */
export const primaryButton = "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 text-sm font-medium whitespace-nowrap text-white shadow-theme-xs transition hover:bg-brand-600 focus:outline-hidden focus:ring-3 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:bg-brand-300";
export const outlineButton = "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-medium whitespace-nowrap text-gray-700 ring-1 ring-gray-300 ring-inset transition hover:bg-gray-50 focus:outline-hidden focus:ring-3 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5";
export const dangerButton = "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-error-500 px-4 text-sm font-medium whitespace-nowrap text-white shadow-theme-xs transition hover:bg-error-600 disabled:cursor-not-allowed disabled:opacity-60";
/** Inline text action inside tables and lists. */
export const linkButton = "text-sm font-medium text-brand-500 hover:text-brand-600 disabled:opacity-50";
export const dangerLink = "text-sm font-medium text-error-500 hover:text-error-600 disabled:opacity-50";
/** Dark code block used for commands and snippets. */
export const codeBlock = "block w-full overflow-x-auto rounded-lg bg-gray-900 px-4 py-3 font-mono text-xs leading-5 whitespace-pre text-gray-100";

export const th = "px-6 py-3 text-start text-theme-xs font-medium text-gray-500 dark:text-gray-400";
export const td = "px-6 py-3.5 text-sm text-gray-700 dark:text-gray-300 align-middle";
export const trBorder = "border-b border-gray-100 last:border-b-0 dark:border-gray-800";
export const muted = "text-gray-500 dark:text-gray-400";

/** Controlled select in the template's input style. */
export function SelectField({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full appearance-none truncate rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 pe-10 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:focus:border-brand-800"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="dark:bg-gray-900">
            {o.label}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-gray-700 dark:text-gray-400" width="18" height="18" viewBox="0 0 20 20" fill="none">
        <path d="M4.79175 8.02075L10.0001 13.2291L15.2084 8.02075" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export const inputClass =
  "h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-800";

export function ButtonLink({ onClick, children, className }: { onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("text-sm font-medium text-brand-500 hover:text-brand-600 dark:text-brand-400", className)}>
      {children}
    </button>
  );
}

/** Underlined tab strip used inside cards. */
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cn("flex gap-6 border-b border-gray-100 px-6 dark:border-gray-800", className)} role="tablist">
      {items.map((item) => (
        <button key={item.value} type="button" role="tab" aria-selected={value === item.value} onClick={() => onChange(item.value)} className={cn("-mb-px border-b-2 px-1 py-3 text-sm font-medium transition", value === item.value ? "border-brand-500 text-brand-600 dark:text-brand-400" : "border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white/90")}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A short explanatory line inside a flush card (between header and table). */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("px-6 py-3 text-sm text-gray-500 dark:text-gray-400", className)}>{children}</p>;
}

/** Toolbar row inside a flush card: text on the left, buttons on the right. */
export function Toolbar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
      <div className="min-w-0 text-sm text-gray-500 dark:text-gray-400">{children}</div>
      {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">{actions}</div>}
    </div>
  );
}
