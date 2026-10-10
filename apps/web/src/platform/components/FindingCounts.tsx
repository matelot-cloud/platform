import type { Severity } from "@/platform/api/types";
import { cn } from "@/utils";
import { muted } from "./ui";

/** Compact severity pills: "2 critical · 5 high" — or a green check when clean. */
export function FindingCounts({ counts, className, checked = true }: { counts?: Record<Severity, number> | null; className?: string; checked?: boolean }) {
  if (!counts) return null;
  if (!checked) return <span className={cn("text-xs", muted, className)}>not checked yet</span>;
  const items: [Severity, string][] = [["critical", "bg-error-500 text-white"], ["high", "bg-warning-500 text-white"], ["medium", "bg-brand-500 text-white"], ["low", "bg-gray-300 text-gray-800 dark:bg-gray-700 dark:text-gray-200"]];
  const shown = items.filter(([s]) => counts[s] > 0);
  if (!shown.length) return <span className={cn("inline-flex items-center gap-1 text-xs text-success-600", className)} title="No open findings">✓ clean</span>;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)} title="Open vulnerabilities by severity (unique advisory per source package)">
      {shown.map(([s, cls]) => <span key={s} className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none", cls)}>{counts[s]} {s}</span>)}
      {typeof (counts as { packages?: number }).packages === "number" && (counts as { packages?: number }).packages! > shown.reduce((n, [s]) => n + counts[s], 0) && <span className={cn("text-[11px]", muted)} title="advisory × package findings">· {(counts as { packages?: number }).packages} package findings</span>}
    </span>
  );
}
