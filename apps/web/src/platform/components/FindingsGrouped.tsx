import Badge from "@/components/ui/badge/Badge";
import { useRegistryInfo } from "@/platform/api/hooks";
import type { FindingEnvironment, FindingRow, Severity } from "@/platform/api/types";
import { Link } from "react-router";
import { relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useMemo, useState } from "react";
import { EnvironmentBadge } from "./Dashboard";
import { BRAND_ICON, BrandIcon, registryBrandForHost } from "./EnvironmentManager";
import { FindingCounts } from "./FindingCounts";
import { SeverityBadge, STATUS_LABEL } from "./Findings";
import { EmptyState, muted, td, th, trBorder } from "./ui";

const ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const worst = (a: Severity, b: Severity) => (ORDER[a] <= ORDER[b] ? a : b);
const count = (rows: FindingRow[]) => { const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }; for (const r of rows) c[r.severity]++; return c; };

interface SourceEntry { key: string; kind: "source" | "image"; label: string; sub: string; brand: keyof typeof BRAND_ICON | "platform"; findings: FindingRow[]; environments: FindingRow["environments"]; latest: string }

/** Groups findings by where they were found: the source repository and each image (per registry). */
function sourcesOf(rows: FindingRow[], builtInHost: string | null): SourceEntry[] {
  const map = new Map<string, SourceEntry>();
  for (const f of rows) {
    for (const s of f.sources) {
      const key = s.target === "image" && s.image ? `image:${s.image}` : `source:${f.serviceId}`;
      let e = map.get(key);
      if (!e) {
        if (s.target === "image" && s.image) {
          const reg = registryBrandForHost(s.image, builtInHost);
          const [host, ...rest] = s.image.split("/");
          e = { key, kind: "image", label: rest.join("/") || s.image, sub: `${reg.label} · ${host}`, brand: reg.brand, findings: [], environments: [], latest: s.createdAt };
        } else {
          e = { key, kind: "source", label: `${f.serviceName} · source`, sub: s.releaseVersion ? `release ${s.releaseVersion}` : s.targetRef, brand: "git", findings: [], environments: [], latest: s.createdAt };
        }
        map.set(key, e);
      }
      if (!e.findings.some((x) => x.id === f.id)) e.findings.push(f);
      for (const env of f.environments) if (!e.environments.some((x) => x.id === env.id)) e.environments.push(env);
      if (s.createdAt > e.latest) e.latest = s.createdAt;
    }
  }
  return [...map.values()].sort((a, b) => (a.kind === "source" ? -1 : 0) - (b.kind === "source" ? -1 : 0) || count(b.findings).critical - count(a.findings).critical || count(b.findings).high - count(a.findings).high);
}

interface PackageGroup { key: string; name: string; version: string | null; type: string; serviceName: string; projectName: string; worst: Severity; findings: FindingRow[]; fixed: string | null; environments: FindingRow["environments"]; kev: boolean }

function groupByPackage(rows: FindingRow[]): PackageGroup[] {
  const map = new Map<string, PackageGroup>();
  for (const f of rows) {
    const key = `${f.serviceId}:${f.component.purl}`;
    let g = map.get(key);
    if (!g) {
      g = { key, name: (f.component.namespace ? `${f.component.namespace}/` : "") + f.component.name, version: f.component.version, type: f.component.type, serviceName: f.serviceName, projectName: f.projectName, worst: f.severity, findings: [], fixed: null, environments: [], kev: false };
      map.set(key, g);
    }
    g.findings.push(f);
    g.worst = worst(g.worst, f.severity);
    g.kev ||= f.advisory.kev;
    if (f.fixedVersion && (!g.fixed || f.fixedVersion > g.fixed)) g.fixed = f.fixedVersion;
    for (const env of f.environments) if (!g.environments.some((x) => x.id === env.id)) g.environments.push(env);
  }
  return [...map.values()].sort((a, b) => (b.environments.some((e) => e.kind === "production") ? 1 : 0) - (a.environments.some((e) => e.kind === "production") ? 1 : 0) || ORDER[a.worst] - ORDER[b.worst] || b.findings.length - a.findings.length);
}

export function FindingsGrouped({ rows, onOpen, showProject = true, environments = [], onChangeImage }: { rows: FindingRow[]; onOpen: (id: string) => void; showProject?: boolean; environments?: FindingEnvironment[]; onChangeImage?: (env: FindingEnvironment) => void }) {
  const registryInfo = useRegistryInfo();
  const [source, setSource] = useState<string | null>(null);
  const [envSel, setEnvSel] = useState<FindingEnvironment | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const sources = useMemo(() => sourcesOf(rows, registryInfo.data?.host ?? null), [rows, registryInfo.data?.host]);
  const bySource = useMemo(() => (source ? rows.filter((f) => (source.startsWith("image:") ? f.sources.some((s) => s.image && `image:${s.image}` === source) : f.sources.some((s) => s.target !== "image") && `source:${f.serviceId}` === source)) : rows), [rows, source]);
  const visible = useMemo(() => (envSel ? bySource.filter((f) => envSel.sbomId && f.sources.some((s) => s.sbomId === envSel.sbomId)) : bySource), [bySource, envSel]);
  const groups = useMemo(() => groupByPackage(visible), [visible]);
  const toggle = (k: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  if (!rows.length && !environments.length) return <EmptyState title="No findings match">Findings appear once SBOMs exist and the correlation has run (right after each SBOM, and every 10 minutes).</EmptyState>;
  const builtInHost = registryInfo.data?.host ?? null;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-12">
      <aside className="border-b border-gray-100 xl:col-span-3 xl:border-r xl:border-b-0 dark:border-gray-800">
        {environments.length > 0 && (
          <>
            <p className={`px-5 pt-4 pb-2 text-xs font-medium uppercase tracking-wide ${muted}`}>Running in</p>
            <ul className="pb-2">
              {[...environments].sort((a, b) => (a.kind === "production" ? -1 : 0) - (b.kind === "production" ? -1 : 0) || a.projectName.localeCompare(b.projectName) || a.serviceName.localeCompare(b.serviceName)).map((e) => {
                const reg = e.current?.image ? registryBrandForHost(e.current.image, builtInHost) : null;
                const selected = envSel?.id === e.id;
                return (
                  <li key={e.id}>
                    <div className={cn("flex items-start gap-3 border-s-4 px-5 py-2.5", selected ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10" : "border-transparent hover:bg-gray-50 dark:hover:bg-white/3")}>
                      <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-start" onClick={() => { setEnvSel(selected ? null : e); setSource(null); }}>
                        {reg ? <BrandIcon name={reg.brand} className="mt-0.5 size-6" /> : <span className="mt-0.5 size-6 rounded-md bg-gray-200 dark:bg-white/10" />}
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5"><span className="text-sm font-medium text-gray-800 dark:text-white/90">{e.name}</span><Badge size="sm" color={e.kind === "production" ? "error" : e.kind === "staging" ? "warning" : "light"}>{e.kind}</Badge>{e.internetFacing && <span className={`text-[11px] ${muted}`}>internet-facing</span>}</span>
                          <span className={`block truncate text-[11px] ${muted}`}>{e.serviceName}{showProject ? ` · ${e.projectName}` : ""}</span>
                          {e.current ? <span className={`block truncate font-mono text-[11px] ${muted}`} title={e.current.image ?? undefined}>{e.current.image ? `${e.current.image.split("/").slice(-1)[0]}:${(e.current.tag ?? "").slice(0, 12)}` : e.current.version ?? "—"}{e.current.digest ? ` · ${e.current.digest.slice(7, 17)}` : ""}</span> : <span className={`block text-[11px] ${muted}`}>nothing deployed</span>}
                          <span className="mt-1 flex flex-wrap items-center gap-1">{e.current ? <FindingCounts counts={e.findings} checked={!!e.sbomId} /> : null}</span>
                        </span>
                      </button>
                      {onChangeImage ? <button type="button" className="shrink-0 text-[11px] font-medium text-brand-500 hover:text-brand-600" onClick={() => onChangeImage(e)}>Change image</button> : <Link to={`/projects/${e.projectId}/environments`} className="shrink-0 text-[11px] font-medium text-brand-500 hover:text-brand-600">Change image</Link>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className={`px-5 pt-4 pb-2 text-xs font-medium uppercase tracking-wide ${muted}`}>Found in</p>
        <ul className="pb-3">
          <li><button type="button" onClick={() => { setSource(null); setEnvSel(null); }} className={cn("flex w-full items-center justify-between gap-2 px-5 py-2 text-sm", source === null ? "bg-brand-50 font-medium text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/3")}><span>All sources</span><FindingCounts counts={count(rows)} /></button></li>
          {sources.map((s) => (
            <li key={s.key}>
              <button type="button" onClick={() => { setSource(source === s.key ? null : s.key); setEnvSel(null); }} className={cn("flex w-full items-start gap-3 border-s-4 px-5 py-2.5 text-start", source === s.key ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10" : "border-transparent hover:bg-gray-50 dark:hover:bg-white/3")}>
                <BrandIcon name={s.brand} className="mt-0.5 size-6" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs font-medium text-gray-800 dark:text-white/90" title={s.label}>{s.label}</span>
                  <span className={`block truncate text-[11px] ${muted}`}>{s.sub} · {relativeTime(s.latest)}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1"><FindingCounts counts={count(s.findings)} />{s.environments.map((e) => <Badge key={e.id} size="sm" color={e.kind === "production" ? "error" : "light"}>{e.name}</Badge>)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="xl:col-span-9">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50/60 px-6 py-2.5 text-sm dark:border-gray-800 dark:bg-white/2">
          <span className="text-gray-700 dark:text-gray-300">
            {envSel ? <>Findings in what runs in <span className="font-semibold text-gray-800 dark:text-white/90">{envSel.name}</span> <span className={muted}>({envSel.serviceName}{envSel.current?.image ? ` · ${envSel.current.image.split("/").slice(-1)[0]}:${(envSel.current.tag ?? "").slice(0, 12)}` : ""})</span></>
              : source ? <>Findings in <span className="font-semibold text-gray-800 dark:text-white/90">{sources.find((x) => x.key === source)?.label ?? "source"}</span></>
              : <>All findings</>}
            <span className={`ms-2 ${muted}`}>· {visible.length} of {rows.length} advisories · {groups.length} packages</span>
          </span>
          {(envSel || source) && <button type="button" className="text-xs font-medium text-brand-500 hover:text-brand-600" onClick={() => { setEnvSel(null); setSource(null); }}>Show all</button>}
        </div>
        {envSel && !envSel.sbomId && <p className="px-6 pt-3 text-sm text-warning-600">No SBOM yet for the image running in {envSel.name}{envSel.current ? "" : " — nothing is deployed there"}. Generate it from Inventory → Container images, then its findings appear here.</p>}
        {(envSel || source) && rows.length > 0 && visible.length === rows.length && <p className={`px-6 pt-3 text-xs ${muted}`}>Same as "all": every open finding comes from this {envSel ? "environment's image" : "source"} — other environments run the same image or have nothing scanned yet.</p>}
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Package</th><th className={th}>Worst</th><th className={th}>Advisories</th><th className={th}>Fix</th><th className={th}>Runs in</th>{showProject && <th className={th}>Service</th>}</tr></thead>
          <tbody>
            {groups.map((g) => {
              const open = expanded.has(g.key);
              return [
                <tr key={g.key} className={`${trBorder} cursor-pointer hover:bg-gray-50 dark:hover:bg-white/2`} onClick={() => toggle(g.key)}>
                  <td className={td}><span className="flex items-center gap-2"><span className={cn("inline-block w-3 text-center text-xs transition", open ? "rotate-90" : "")}>▶</span><span><span className="font-medium text-gray-800 dark:text-white/90">{g.name}</span><span className={`block font-mono text-xs ${muted}`}>{g.version} · {g.type}</span></span></span></td>
                  <td className={td}><SeverityBadge severity={g.worst} />{g.kev && <Badge size="sm" color="error">KEV</Badge>}</td>
                  <td className={td}><FindingCounts counts={count(g.findings)} /></td>
                  <td className={`${td} font-mono text-xs`}>{g.fixed ? <span className="text-success-600">→ {g.fixed}</span> : <span className={muted}>no fix known</span>}</td>
                  <td className={td}>{g.environments.length ? <span className="flex flex-wrap gap-1">{g.environments.map((e) => <EnvironmentBadge key={e.id} name={e.name} kind={e.kind} internetFacing={e.internetFacing} />)}</span> : <span className={`text-xs ${muted}`}>not running</span>}</td>
                  {showProject && <td className={td}><span className="text-sm text-gray-800 dark:text-white/90">{g.serviceName}</span><span className={`block text-xs ${muted}`}>{g.projectName}</span></td>}
                </tr>,
                open && (
                  <tr key={`${g.key}-x`} className={trBorder}>
                    <td colSpan={showProject ? 6 : 5} className="bg-gray-50/60 px-6 py-2 dark:bg-white/2">
                      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                        {[...g.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (b.advisory.cvssScore ?? 0) - (a.advisory.cvssScore ?? 0)).map((f) => (
                          <li key={f.id} className="flex cursor-pointer flex-wrap items-center gap-3 py-2 text-sm hover:bg-white dark:hover:bg-white/3" onClick={() => onOpen(f.id)}>
                            <span className="w-28 shrink-0"><SeverityBadge severity={f.severity} score={f.advisory.cvssScore} /></span>
                            <span className="w-44 shrink-0 font-mono text-xs text-gray-800 dark:text-white/90">{f.advisory.aliases.find((a) => a.startsWith("CVE-")) ?? f.advisory.id}</span>
                            <span className={`min-w-0 flex-1 truncate ${muted}`} title={f.advisory.summary ?? ""}>{f.advisory.summary ?? f.advisory.id}</span>
                            {f.advisory.kev && <Badge size="sm" color="error">KEV</Badge>}
                            {typeof f.advisory.epssScore === "number" && f.advisory.epssScore >= 0.1 && <span className={`text-[11px] ${muted}`}>EPSS {(f.advisory.epssScore * 100).toFixed(0)}%</span>}
                            <span className={`w-24 shrink-0 font-mono text-xs ${f.fixedVersion ? "text-success-600" : muted}`}>{f.fixedVersion ?? "no fix"}</span>
                            <Badge size="sm" color={f.status === "open" ? "warning" : f.status === "fixed" ? "success" : "light"}>{STATUS_LABEL[f.status]}</Badge>
                            <span className={`text-[11px] ${muted}`}>in {f.sources.length} {f.sources.length === 1 ? "SBOM" : "SBOMs"}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {groups.length === 0 && <EmptyState title={envSel ? "No open findings in what runs here" : "Nothing in this source"} />}
      </div>
    </div>
  );
}
