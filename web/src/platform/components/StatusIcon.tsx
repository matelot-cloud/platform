import type { JobStatus, PipelineStatus } from "@/platform/api/types";
import { cn } from "@/utils";

type Status = JobStatus | PipelineStatus;

const STYLE: Record<Status, { ring: string; glyph: string; label: string; spin?: boolean }> = {
  succeeded: { ring: "border-success-500 text-success-500", glyph: "✓", label: "Passed" },
  failed: { ring: "border-error-500 text-error-500", glyph: "✕", label: "Failed" },
  timed_out: { ring: "border-error-500 text-error-500", glyph: "⏱", label: "Timed out" },
  cancelled: { ring: "border-gray-400 text-gray-500", glyph: "⊘", label: "Cancelled" },
  skipped: { ring: "border-gray-300 text-gray-400 border-dashed", glyph: "»", label: "Skipped" },
  running: { ring: "border-brand-500 text-brand-500", glyph: "", label: "Running", spin: true },
  assigned: { ring: "border-brand-400 text-brand-400", glyph: "", label: "Starting", spin: true },
  queued: { ring: "border-warning-500 text-warning-500", glyph: "…", label: "Waiting for a runner" },
  pending: { ring: "border-gray-300 text-gray-400", glyph: "·", label: "Waiting for the previous stage" },
  created: { ring: "border-gray-300 text-gray-400", glyph: "·", label: "Created" },
};

export const statusLabel = (status: Status) => STYLE[status]?.label ?? status;
/** Platform jobs (policy_eval, tag __platform__) wait for the platform worker, not for a runner. */
export const jobStatusLabel = (job: { status: Status; type?: string; requiredTags?: string[] | null }, platformWorkerSeenAt?: string | null) => {
  if (job.status !== "queued" || !(job.type === "policy_eval" || job.requiredTags?.includes("__platform__"))) return statusLabel(job.status);
  if (!platformWorkerSeenAt) return "Waiting for the platform worker (not running?)";
  const min = Math.round((Date.now() - new Date(platformWorkerSeenAt).getTime()) / 60_000);
  return min > 1 ? `Waiting for the platform worker (last seen ${min} min ago)` : "Waiting for the platform worker";
};

/** GitLab-style status circle. */
export function StatusIcon({ status, size = "md", className }: { status: Status; size?: "sm" | "md" | "lg"; className?: string }) {
  const style = STYLE[status] ?? STYLE.created;
  const dim = size === "sm" ? "size-4 text-[10px]" : size === "lg" ? "size-8 text-base" : "size-6 text-xs";
  return (
    <span title={style.label} aria-label={style.label} className={cn("inline-flex shrink-0 items-center justify-center rounded-full border-2 font-bold leading-none", dim, style.ring, style.spin && "animate-spin border-t-transparent", className)}>
      {style.glyph}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  const style = STYLE[status] ?? STYLE.created;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", style.ring.replace("border-dashed", ""))}>
      <StatusIcon status={status} size="sm" /> {style.label}
    </span>
  );
}
