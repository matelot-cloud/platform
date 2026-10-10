import Badge from "@/components/ui/badge/Badge";
import type { FindingTrendSeries } from "@/platform/api/types";
import { cn } from "@/utils";
import { useMemo, useState } from "react";
import { EmptyState, muted } from "./ui";

type Metric = "criticalHigh" | "critical" | "high" | "all" | "kev";
const METRIC_LABEL: Record<Metric, string> = { criticalHigh: "critical + high", critical: "critical", high: "high", all: "all severities", kev: "known exploited" };
const value = (p: FindingTrendSeries["points"][number], m: Metric) => (m === "criticalHigh" ? p.critical + p.high : m === "critical" ? p.critical : m === "high" ? p.high : m === "kev" ? p.kev : p.critical + p.high + p.medium + p.low);
const PALETTE = ["#465fff", "#f04438", "#f79009", "#12b76a", "#7a5af8", "#0ba5ec", "#ee46bc", "#667085"];

/** Multi-series line chart of open findings per environment over time (SVG, no dependency). */
export function FindingTrend({ series, days, onDays, showProject = true }: { series: FindingTrendSeries[]; days: number; onDays: (d: number) => void; showProject?: boolean }) {
  const [metric, setMetric] = useState<Metric>("criticalHigh");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ day: string; x: number } | null>(null);
  const sorted = useMemo(() => [...series].sort((a, b) => (a.kind === "production" ? -1 : 0) - (b.kind === "production" ? -1 : 0) || a.serviceName.localeCompare(b.serviceName)), [series]);
  const daysList = useMemo(() => { const out: string[] = []; const end = new Date(); end.setUTCHours(0, 0, 0, 0); for (let i = days - 1; i >= 0; i--) out.push(new Date(end.getTime() - i * 86400_000).toISOString().slice(0, 10)); return out; }, [days]);
  const W = 720, H = 220, L = 36, R = 12, T = 12, B = 28;
  const shown = sorted.filter((s) => !hidden.has(s.environmentId));
  const max = Math.max(1, ...shown.flatMap((s) => s.points.map((p) => value(p, metric))));
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, daysList.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const path = (s: FindingTrendSeries) => { const by = new Map(s.points.map((p) => [p.day, p])); let last: number | null = null; return daysList.map((d, i) => { const p = by.get(d); const v = p ? value(p, metric) : last; if (v === null) return null; last = v; return `${i === 0 || !by.get(daysList[i - 1]) && last === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; }).filter(Boolean).join(" ").replace(/^L/, "M"); };
  const ticks = [0, Math.round(max / 2), max];
  const hoverIdx = hover ? daysList.indexOf(hover.day) : -1;
  if (!series.length) return <EmptyState title="No history yet">Snapshots are taken after each correlation (and backfilled from the deployment history once the worker runs).</EmptyState>;
  return (
    <div className="px-5 pb-4">
      <div className="flex flex-wrap items-center gap-2 py-3">
        <div className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-white/5">{([7, 30, 90] as const).map((d) => <button key={d} type="button" onClick={() => onDays(d)} className={cn("rounded-md px-2.5 py-1 text-xs font-medium", days === d ? "bg-white text-gray-800 shadow-theme-xs dark:bg-gray-800 dark:text-white/90" : "text-gray-600 dark:text-gray-400")}>{d} days</button>)}</div>
        <div className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-white/5">{(Object.keys(METRIC_LABEL) as Metric[]).map((m) => <button key={m} type="button" onClick={() => setMetric(m)} className={cn("rounded-md px-2.5 py-1 text-xs font-medium", metric === m ? "bg-white text-gray-800 shadow-theme-xs dark:bg-gray-800 dark:text-white/90" : "text-gray-600 dark:text-gray-400")}>{METRIC_LABEL[m]}</button>)}</div>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)} onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; const i = Math.round(((px - L) / (W - L - R)) * (daysList.length - 1)); if (i >= 0 && i < daysList.length) setHover({ day: daysList[i], x: x(i) }); }}>
          {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-gray-200 dark:text-gray-800" strokeDasharray="3 3" /><text x={L - 6} y={y(t) + 4} textAnchor="end" className="fill-gray-400" fontSize="10">{t}</text></g>)}
          {daysList.map((d, i) => (i % Math.ceil(daysList.length / 6) === 0 || i === daysList.length - 1) && <text key={d} x={x(i)} y={H - 8} textAnchor="middle" className="fill-gray-400" fontSize="10">{d.slice(5)}</text>)}
          {hover && <line x1={hover.x} x2={hover.x} y1={T} y2={H - B} stroke="currentColor" className="text-gray-300 dark:text-gray-700" />}
          {shown.map((s) => <path key={s.environmentId} d={path(s)} fill="none" stroke={PALETTE[sorted.indexOf(s) % PALETTE.length]} strokeWidth={s.kind === "production" ? 2.5 : 1.6} strokeLinejoin="round" />)}
          {hover && shown.map((s) => { const p = s.points.find((pt) => pt.day === hover.day); return p ? <circle key={s.environmentId} cx={hover.x} cy={y(value(p, metric))} r={3.5} fill={PALETTE[sorted.indexOf(s) % PALETTE.length]} /> : null; })}
        </svg>
        {hover && hoverIdx >= 0 && (
          <div className="pointer-events-none absolute top-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-theme-md dark:border-gray-800 dark:bg-gray-900" style={{ left: `${Math.min(80, (hover.x / W) * 100)}%` }}>
            <p className="font-medium text-gray-800 dark:text-white/90">{hover.day}</p>
            {shown.map((s) => { const p = s.points.find((pt) => pt.day === hover.day); return <p key={s.environmentId} className={muted}><span className="inline-block size-2 rounded-full" style={{ background: PALETTE[sorted.indexOf(s) % PALETTE.length] }} /> {s.name} · {s.serviceName}: <span className="text-gray-800 dark:text-white/90">{p ? value(p, metric) : "—"}</span>{p?.version ? ` (${p.version})` : ""}</p>; })}
          </div>
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {sorted.map((s, i) => { const last = s.points[s.points.length - 1]; const off = hidden.has(s.environmentId); return (
          <li key={s.environmentId}>
            <button type="button" onClick={() => setHidden((prev) => { const n = new Set(prev); if (n.has(s.environmentId)) n.delete(s.environmentId); else n.add(s.environmentId); return n; })} className={cn("flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs", off ? "border-gray-200 text-gray-400 dark:border-gray-800" : "border-gray-200 text-gray-700 dark:border-gray-700 dark:text-gray-300")}>
              <span className="inline-block size-2.5 rounded-full" style={{ background: off ? "#d0d5dd" : PALETTE[i % PALETTE.length] }} />
              <span className="font-medium">{s.name}</span><Badge size="sm" color={s.kind === "production" ? "error" : "light"}>{s.kind}</Badge><span className={muted}>{s.serviceName}{showProject ? ` · ${s.projectName}` : ""}</span>
              {last && <span className="font-mono text-gray-800 dark:text-white/90">{value(last, metric)}</span>}
            </button>
          </li>
        ); })}
      </ul>
    </div>
  );
}
