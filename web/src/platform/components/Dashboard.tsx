import Badge from "@/components/ui/badge/Badge";
import type { EnvironmentKind, PipelineStatus } from "@/platform/api/types";
import { relativeTime } from "@/platform/format";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ENV_COLOR } from "./ServicePanel";
import { StatusIcon } from "./StatusIcon";
import { muted } from "./ui";

/** Compact KPI tile: a number, a label, an optional trend/caption line and a tone for the number. */
export function Kpi({ label, value, caption, tone = "default", to }: { label: string; value: ReactNode; caption?: ReactNode; tone?: "default" | "good" | "warn" | "bad"; to?: string }) {
  const color = { default: "text-gray-800 dark:text-white/90", good: "text-success-600", warn: "text-warning-600", bad: "text-error-500" }[tone];
  const body = (
    <div className="flex h-full flex-col rounded-2xl border border-gray-200 bg-white px-5 py-4 transition hover:border-gray-300 dark:border-gray-800 dark:bg-white/3 dark:hover:border-gray-700">
      <p className={`text-xs font-medium uppercase tracking-wide ${muted}`}>{label}</p>
      <p className={`mt-1 text-2xl font-semibold leading-tight ${color}`}>{value}</p>
      {caption && <p className={`mt-1 text-xs ${muted}`}>{caption}</p>}
    </div>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}

/** Thin stacked bar: succeeded / failed / running share of pipelines. */
export function PipelineBar({ succeeded, failed, running, total }: { succeeded: number; failed: number; running: number; total: number }) {
  if (!total) return <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800" />;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" title={`${succeeded} succeeded · ${failed} failed · ${running} running`}>
      <div className="bg-success-500" style={{ width: pct(succeeded) }} />
      <div className="bg-error-500" style={{ width: pct(failed) }} />
      <div className="bg-brand-400" style={{ width: pct(running) }} />
    </div>
  );
}

export function EnvironmentBadge({ name, kind, internetFacing, isProtected }: { name: string; kind: EnvironmentKind; internetFacing?: boolean; isProtected?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge size="sm" color={ENV_COLOR[kind] ?? "light"}>{name}</Badge>
      {internetFacing && <span className={`text-[11px] ${muted}`}>internet-facing</span>}
      {isProtected && <span className={`text-[11px] ${muted}`}>· protected</span>}
    </span>
  );
}

/** One line per pipeline for dashboards: status icon, name #n, ref, when. */
export function PipelineLine({ p, to }: { p: { number: number; status: PipelineStatus; name: string; ref: string | null; trigger: string; createdAt: string; serviceName: string; projectName?: string }; to: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 px-6 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-white/3">
      <StatusIcon status={p.status} size="sm" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-gray-800 dark:text-white/90">{p.serviceName}</span>
        <span className={muted}> · {p.name} #{p.number}{p.ref ? ` · ${p.ref.length > 12 ? p.ref.slice(0, 10) : p.ref}` : ""}{p.projectName ? ` · ${p.projectName}` : ""}</span>
      </span>
      <span className={`shrink-0 text-xs ${muted}`}>{p.trigger} · {relativeTime(p.createdAt)}</span>
    </Link>
  );
}

/** Small "what runs" cell: version (or build), digest tail, since, SBOM dot. */
export function RunningCell({ current }: { current: { version: string | null; digest?: string | null; tag?: string | null; imageRef?: string | null; deployedAt: string; source: string; hasSbom: boolean } | null }) {
  if (!current) return <span className={`text-xs ${muted}`}>nothing recorded</span>;
  const label = current.version ?? (current.tag ? `build ${current.tag.slice(0, 7)}` : current.imageRef ? current.imageRef.split("@")[0].split("/").slice(-1)[0] : "—");
  return (
    <span className="flex flex-col">
      <span className="font-medium text-gray-800 dark:text-white/90">{label}{current.digest && <span className={`ms-2 font-mono text-[11px] ${muted}`}>{current.digest.slice(7, 17)}</span>}</span>
      <span className={`text-xs ${muted}`}>{relativeTime(current.deployedAt)} · {current.source === "registry" ? "registry" : current.source}{current.hasSbom ? " · SBOM ✓" : " · no SBOM"}</span>
    </span>
  );
}
