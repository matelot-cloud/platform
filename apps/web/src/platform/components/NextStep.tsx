import type { ReactNode } from "react";

/** First-run guidance inside a scope that is still empty: what to do next, with the action right there. */
export function NextStep({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-25 p-5 dark:border-brand-500/30 dark:bg-brand-500/5" data-testid="next-step">
      <p className="text-xs font-medium uppercase tracking-wide text-brand-600 dark:text-brand-400">Next step</p>
      <h3 className="mt-1 text-base font-semibold text-gray-800 dark:text-white/90">{title}</h3>
      {children && <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">{children}</div>}
      {actions && <div className="mt-4 flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}
