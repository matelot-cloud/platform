import { useActiveJobs, useAuditEvents, type ActiveJob } from "@/platform/api/hooks";
import type { AuditEvent } from "@/platform/api/types";
import { relativeTime } from "@/platform/format";
import { useCurrentOrganization } from "@/platform/state/useCurrentOrganization";
import { cn } from "@/utils";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent", className)} />;
}

/** Human description of a background job. */
export function describeJob(j: Pick<ActiveJob, "type" | "payload" | "name">): string {
  const p = j.payload ?? {};
  const short = (ref: unknown) => (typeof ref === "string" ? ref.split("/").slice(-1)[0].replace(/:([0-9a-f]{12})[0-9a-f]+$/, ":$1") : "");
  switch (j.type) {
    case "sbom": return p.target === "image" ? `Generating SBOM · ${short(p.imageRef)}` : `Generating SBOM · source${p.version ? ` ${p.version}` : ""}`;
    case "secrets": return "Scanning for secrets";
    case "iac": return "Checking infrastructure as code";
    case "repository_check": return "Checking out repository";
    case "kubernetes_inventory": return "Reading Kubernetes workloads";
    default: return j.name ?? j.type.replace(/_/g, " ");
  }
}

const FEED_ACTIONS: Record<string, (e: AuditEvent) => string> = {
  "deployment.recorded": (e) => { const a = (e.after ?? {}) as Record<string, unknown>; return `Deployed ${a.version ?? "a build"} to ${a.environmentName ?? a.environment ?? "an environment"}`; },
  "release.created": (e) => `Release ${((e.after ?? {}) as Record<string, unknown>).version ?? ""} created`,
  "image.pushed": (e) => { const a = (e.after ?? {}) as Record<string, unknown>; return `Image pushed · ${String(a.tag ?? a.image ?? "").slice(0, 24)}`; },
  "sbom.ingested": (e) => { const a = (e.after ?? {}) as Record<string, unknown>; return `SBOM stored · ${a.components ?? "?"} components`; },
  "finding.opened": (e) => `New finding · ${((e.after ?? {}) as Record<string, unknown>).advisory ?? ""}`,
  "code_finding.opened": (e) => { const a = (e.after ?? {}) as Record<string, unknown>; return `Code finding · ${a.kind ?? ""} in ${String(a.file ?? "").split("/").slice(-1)[0]}`; },
  "finding.status_changed": (e) => `Finding marked ${((e.after ?? {}) as Record<string, unknown>).status ?? ""}`,
  "registry.credentials_issued": (e) => `Registry login · ${((e.after ?? {}) as Record<string, unknown>).host ?? ""}`,
  "personal_token.created": () => "Personal token created",
  "notification.sent": (e) => `Notification sent · ${((e.after ?? {}) as Record<string, unknown>).title ?? ""}`,
  "deployment.rejected": (e) => `Deployment rejected · ${((e.after ?? {}) as Record<string, unknown>).version ?? ""}`,
};

/** Header indicator: spins while anything runs; lists queued/running work and the latest events from CI and the platform. */
export function ActivityIndicator() {
  const { organization } = useCurrentOrganization();
  const active = useActiveJobs(organization?.id);
  const audit = useAuditEvents(organization?.id, 15);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState<number>(() => Date.now());
  const feed = (audit.data ?? []).filter((e) => FEED_ACTIONS[e.action]);
  const fresh = feed.filter((e) => new Date(e.createdAt).getTime() > seenAt).length;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);
  if (!organization) return null;
  const jobs = active.data ?? [];
  const running = jobs.filter((j) => j.status === "running" || j.status === "assigned").length;
  const queued = jobs.length - running;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => { setOpen((v) => !v); if (!open) setSeenAt(Date.now()); }} className={cn("relative flex h-11 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition", jobs.length ? "border-brand-200 bg-brand-50 text-brand-600 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-400" : "border-gray-200 text-gray-500 hover:bg-gray-100 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5")} aria-label="Background activity">
        {jobs.length ? <Spinner /> : <span className="inline-block size-2 rounded-full bg-success-500" />}
        <span className="hidden sm:inline">{jobs.length ? `${running} running${queued ? ` · ${queued} queued` : ""}` : "Idle"}</span>
        {fresh > 0 && <span className="absolute -end-1 -top-1 flex size-5 items-center justify-center rounded-full bg-brand-500 text-[10px] font-semibold text-white"><span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-400 opacity-60" />{fresh}</span>}
      </button>
      {open && (
        <div className="absolute end-0 z-99999 mt-2 w-96 rounded-2xl border border-gray-200 bg-white p-2 shadow-theme-lg dark:border-gray-800 dark:bg-gray-900">
          <p className="px-3 pt-1 pb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Background activity</p>
          {jobs.length === 0 ? <p className="px-3 pb-2 text-sm text-gray-500 dark:text-gray-400">Nothing running right now.</p> : (
            <ul className="max-h-96 overflow-y-auto">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link to={j.projectId ? `/projects/${j.projectId}/jobs/${j.id}` : "#"} onClick={() => setOpen(false)} className="flex items-start gap-3 rounded-xl px-3 py-2 hover:bg-gray-50 dark:hover:bg-white/5">
                    {j.status === "queued" ? <span className="mt-1 inline-block size-3 shrink-0 rounded-full border-2 border-gray-300 dark:border-gray-600" /> : <Spinner className="mt-1" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-gray-800 dark:text-white/90">{describeJob(j)}</span>
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{j.serviceName ?? "—"} · {j.status === "queued" ? `queued ${relativeTime(j.createdAt)}` : `running since ${relativeTime(j.startedAt ?? j.createdAt)}`}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-gray-100 px-3 pt-3 pb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">Recent events</p>
          {feed.length === 0 ? <p className="px-3 pb-3 text-sm text-gray-500 dark:text-gray-400">Deployments, releases, pushes and scan results appear here as they happen.</p> : (
            <ul className="max-h-72 overflow-y-auto">
              {feed.slice(0, 12).map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-3 py-1.5">
                  <span className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", new Date(e.createdAt).getTime() > seenAt ? "bg-brand-500" : "bg-gray-300 dark:bg-gray-600")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-800 dark:text-white/90">{FEED_ACTIONS[e.action](e)}</span>
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{e.actorLabel ?? "system"} · {relativeTime(e.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
