import Badge from "@/components/ui/badge/Badge";
import { useProjectGraph, useRecomputeRisk, useRegistryInfo, useServiceRisk } from "@/platform/api/hooks";
import type { GraphEdge, GraphNode, RiskGrade, Severity } from "@/platform/api/types";
import { EnvironmentBadge } from "@/platform/components/Dashboard";
import { BrandIcon, registryBrandForHost } from "@/platform/components/EnvironmentManager";
import { FindingCounts } from "@/platform/components/FindingCounts";
import { RiskFactorList, RiskGradeTile } from "@/platform/components/Risk";
import { Card, EmptyState, ErrorNotice, muted, outlineButton } from "@/platform/components/ui";
import { relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useProject } from "./layout";
import { EnvironmentLineageView } from "@/platform/components/EnvironmentLineage";
import { Tabs } from "@/platform/components/ui";

type Col = "repository" | "release" | "image" | "environment";
const COLS: { key: Col; title: string; hint: string }[] = [
  { key: "repository", title: "Source", hint: "repositories" },
  { key: "release", title: "Releases", hint: "versions with their source SBOM" },
  { key: "image", title: "Registries", hint: "where each release's image is stored" },
  { key: "environment", title: "Environments", hint: "what runs where" },
];

/** One card per (release or plain builds) × registry repository: the tags of that release in that registry, its digest, its findings. */
function groupImagesByRegistry(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const parentOf = new Map<string, string>();
  for (const e of edges) if (e.to.startsWith("image:") && !e.from.startsWith("image:")) parentOf.set(e.to, e.from);
  const groupOf = new Map<string, string>();
  const groups = new Map<string, GraphNode>();
  for (const n of nodes) {
    if (n.type !== "image") continue;
    const name = String(n.data.image ?? "");
    const parent = parentOf.get(n.id) ?? "none";
    const gid = `registry:${parent}|${name}`;
    groupOf.set(n.id, gid);
    let g = groups.get(gid);
    if (!g) {
      g = { id: gid, type: "image", label: name.split("/").slice(1).join("/") || name, sub: name.split("/")[0], data: { image: name, tags: [] as string[], digests: [] as string[], findings: null, sbomId: null, deployed: false, group: true, builds: parent.startsWith("service:") } };
      groups.set(gid, g);
    }
    const d = g.data as { tags: string[]; digests: string[]; findings: unknown; sbomId: unknown; deployed: boolean };
    d.tags.push(String(n.data.tag));
    if (n.data.digest && !d.digests.includes(String(n.data.digest))) d.digests.push(String(n.data.digest));
    if (n.data.deployed && n.data.sbomId) { d.sbomId = n.data.sbomId; d.findings = n.data.findings; }
    else if (!d.sbomId && n.data.sbomId) { d.sbomId = n.data.sbomId; d.findings = n.data.findings; }
    if (n.data.deployed) d.deployed = true;
  }
  const seen = new Set<string>();
  const outEdges: GraphEdge[] = [];
  for (const e of edges) {
    const from = groupOf.get(e.from) ?? e.from;
    const to = groupOf.get(e.to) ?? e.to;
    const key = `${from}>${to}`;
    if (from === to || seen.has(key)) continue;
    seen.add(key);
    outEdges.push({ ...e, from, to });
  }
  return { nodes: [...nodes.filter((n) => n.type !== "image"), ...groups.values()], edges: outEdges };
}

function NodeCard({ n, projectId, builtInHost, dim, highlight = false, focused = false }: { n: GraphNode; projectId: string; builtInHost: string | null; dim: boolean; highlight?: boolean; focused?: boolean }) {
  const d = n.data;
  const findings = d.findings as Record<Severity, number> | null | undefined;
  const base = cn("w-full cursor-pointer rounded-xl border bg-white px-3 py-2 text-start shadow-theme-xs transition duration-150 dark:bg-white/3", dim ? "opacity-25 grayscale" : "", highlight ? "ring-2 ring-brand-500/40" : "", focused ? "ring-2 ring-brand-500 shadow-theme-md" : "", n.type === "environment" && d.kind === "production" ? "border-error-200 dark:border-error-500/40" : "border-gray-200 dark:border-gray-800");
  if (n.type === "repository") return <div className={base}><BrandIcon name={String(d.url ?? "").includes("gitlab") ? "gitlab" : String(d.url ?? "").includes("github") ? "github" : "git"} className="mb-1 size-5" /><p className="truncate font-mono text-xs font-medium text-gray-800 dark:text-white/90" title={n.label}>{n.label}</p>{n.sub && <p className={`text-[11px] ${muted}`}>{n.sub}</p>}</div>;
  if (n.type === "release") return <div className={base}><p className="flex items-center justify-between gap-2"><span className="font-semibold text-gray-800 dark:text-white/90">{n.label}</span>{d.deployed ? <Badge size="sm" color="success">deployed</Badge> : null}</p><p className={`font-mono text-[11px] ${muted}`}>{n.sub ?? "no commit"}</p>{findings ? <FindingCounts counts={findings} className="mt-1" /> : <p className={`text-[11px] ${muted}`}>{d.sbomId ? "" : "no SBOM"}</p>}{d.sbomId ? <Link to={`/projects/${projectId}/sboms/${d.sbomId}`} className="text-[11px] text-brand-500 hover:underline">SBOM</Link> : null}</div>;
  if (n.type === "image") {
    const reg = registryBrandForHost(String(d.image ?? ""), builtInHost);
    const tags = (d.tags as string[] | undefined) ?? [String(d.tag ?? "")];
    const shortTag = (t: string) => (/^[0-9a-f]{12,}/i.test(t) ? t.slice(0, 12) + t.slice(40) : t);
    const digests = (d.digests as string[] | undefined) ?? (d.digest ? [String(d.digest)] : []);
    return (
      <div className={base}>
        <p className="flex items-center gap-2"><BrandIcon name={reg.brand} className="size-5" /><span className="truncate text-xs font-semibold text-gray-800 dark:text-white/90">{reg.label}</span>{d.deployed ? <Badge size="sm" color="success">running</Badge> : null}</p>
        <p className={`mt-0.5 truncate font-mono text-[11px] ${muted}`} title={String(d.image ?? "")}>{n.label}</p>
        <p className="mt-1 flex flex-wrap gap-1">{tags.slice(0, 3).map((t) => <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-700 dark:bg-white/5 dark:text-gray-300" title={t}>{shortTag(t)}</span>)}{tags.length > 3 && <span className={`text-[10px] ${muted}`}>+{tags.length - 3}</span>}</p>
        {digests.length > 0 && <p className={`mt-1 truncate font-mono text-[10px] ${muted}`} title={digests.join("\n")}>{digests[0].slice(7, 19)}{digests.length > 1 ? ` +${digests.length - 1}` : ""}</p>}
        {findings ? <FindingCounts counts={findings} className="mt-1" /> : <p className={`text-[11px] ${muted}`}>not scanned</p>}
        {typeof d.packageFindings === "number" && d.packageFindings > 0 && <p className={`text-[11px] ${muted}`} title="Counts above: unique vulnerabilities (advisory per source package). This: advisory × package.">{d.packageFindings} package findings</p>}
      </div>
    );
  }
  return (
    <div className={base}>
      <p className="flex items-center gap-2"><EnvironmentBadge name={n.label} kind={String(d.kind) as never} internetFacing={!!d.internetFacing} />{d.protected ? <span className={`text-[11px] ${muted}`}>protected</span> : null}</p>
      {d.version || d.image ? <p className={`mt-1 truncate font-mono text-[11px] ${muted}`} title={String(d.image ?? d.version ?? "")}>{d.version ? `${d.version}` : ""}{d.image ? ` · ${String(d.image).split("/").slice(-1)[0].slice(0, 28)}` : ""}</p> : <p className={`mt-1 text-[11px] ${muted}`}>nothing deployed</p>}
      {d.deployedAt ? <p className={`text-[11px] ${muted}`}>since {relativeTime(String(d.deployedAt))}</p> : null}
      {d.version || d.image ? <FindingCounts counts={findings ?? null} checked={!!d.sbomId} className="mt-1" /> : null}
    </div>
  );
}

function ServiceGraph({ serviceNode, nodes, edges, projectId, builtInHost }: { serviceNode: GraphNode; nodes: GraphNode[]; edges: { from: string; to: string }[]; projectId: string; builtInHost: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ x1: number; y1: number; x2: number; y2: number; key: string }[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const risk = useServiceRisk(String(serviceNode.data.serviceId));
  const reach = useMemo(() => {
    // nodes connected to this service (transitively through releases/images/environments)
    const set = new Set<string>([serviceNode.id]);
    let grew = true;
    while (grew) { grew = false; for (const e of edges) { if (set.has(e.from) && !set.has(e.to)) { set.add(e.to); grew = true; } } }
    return set;
  }, [edges, serviceNode.id]);
  const mine = nodes.filter((n) => reach.has(n.id) && n.id !== serviceNode.id);
  const byCol = (c: Col) => mine.filter((n) => n.type === c);
  const related = useMemo(() => {
    if (!focus) return null;
    // The whole path through the hovered card: every ancestor (towards the source) and every descendant (towards environments).
    const walk = (start: string, dir: "down" | "up") => {
      const out = new Set<string>([start]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of edges) {
          const next = dir === "down" ? (e.from === cur ? e.to : null) : e.to === cur ? e.from : null;
          if (next && !out.has(next) && next !== serviceNode.id) { out.add(next); queue.push(next); }
        }
      }
      return out;
    };
    return new Set<string>([...walk(focus, "down"), ...walk(focus, "up")]);
  }, [focus, edges, serviceNode.id]);
  useLayoutEffect(() => {
    const root = ref.current; if (!root) return;
    const compute = () => {
      const r = root.getBoundingClientRect();
      const pos = new Map<string, DOMRect>();
      root.querySelectorAll<HTMLElement>("[data-node]").forEach((el) => pos.set(el.dataset.node!, el.getBoundingClientRect()));
      const out: typeof lines = [];
      for (const e of edges) { const a = pos.get(e.from); const b = pos.get(e.to); if (!a || !b) continue; out.push({ key: `${e.from}>${e.to}`, x1: a.right - r.left, y1: a.top + a.height / 2 - r.top, x2: b.left - r.left, y2: b.top + b.height / 2 - r.top }); }
      setLines(out);
    };
    compute();
    const ro = new ResizeObserver(compute); ro.observe(root);
    return () => ro.disconnect();
  }, [edges, mine.length]);
  const grade = (serviceNode.data.grade as RiskGrade | null) ?? null;
  return (
    <Card title={<span className="flex items-center gap-3"><RiskGradeTile grade={grade} score={(serviceNode.data.risk as number | null) ?? null} size="sm" /> {serviceNode.label}</span>} description={serviceNode.sub ? `criticality ${serviceNode.sub}` : undefined} flush>
      <div ref={ref} className="relative overflow-x-auto p-5">
        <svg className="pointer-events-none absolute inset-0 h-full w-full">{lines.map((l) => { const on = !related || (related.has(l.key.split(">")[0]) && related.has(l.key.split(">")[1])); return <path key={l.key} d={`M${l.x1},${l.y1} C${l.x1 + 30},${l.y1} ${l.x2 - 30},${l.y2} ${l.x2},${l.y2}`} fill="none" stroke="currentColor" className={related ? (on ? "text-brand-500" : "text-gray-100 dark:text-gray-900") : "text-gray-300 dark:text-gray-700"} strokeWidth={on && related ? 2.5 : 1.2} />; })}</svg>
        <p className={`relative mb-3 text-xs ${muted}`}>Hover any card to follow its path — from the source through releases and images to the environments running it.</p>
        <div className="relative grid min-w-200 grid-cols-4 gap-8">
          {COLS.map((c) => (
            <div key={c.key} className="space-y-3">
              <p className={`text-xs font-medium uppercase tracking-wide ${muted}`}>{c.title} <span className="font-normal normal-case">· {c.hint}</span></p>
              {byCol(c.key).length === 0 && <p className={`text-xs ${muted}`}>none</p>}
              {byCol(c.key).map((n) => <div key={n.id} data-node={n.id} onMouseEnter={() => setFocus(n.id)} onMouseLeave={() => setFocus(null)}><NodeCard n={n} projectId={projectId} builtInHost={builtInHost} dim={!!related && !related.has(n.id)} highlight={!!related && related.has(n.id)} focused={focus === n.id} /></div>)}
            </div>
          ))}
        </div>
      </div>
      {risk.data?.latest && <div className="border-t border-gray-100 px-5 py-4 dark:border-gray-800"><p className={`mb-2 text-xs font-medium uppercase ${muted}`}>Why this risk score</p><RiskFactorList factors={risk.data.latest.factors} /></div>}
    </Card>
  );
}

export default function ProjectGraphPage() {
  const { organization, project, service, focusService } = useProject();
  const graph = useProjectGraph(project.id);
  const registryInfo = useRegistryInfo();
  const recompute = useRecomputeRisk(organization.id, project.id);
  if (graph.error) return <ErrorNotice error={graph.error} />;
  const grouped = useMemo(() => groupImagesByRegistry(graph.data?.nodes ?? [], graph.data?.edges ?? []), [graph.data]);
  const nodes = grouped.nodes;
  const edges = grouped.edges;
  const serviceNodes = nodes.filter((n) => n.type === "service" && (!service || n.data.serviceId === service.id));
  const [tab, setTab] = useState<"environments" | "map">("environments");
  const focus = focusService;
  return (
    <div className="space-y-6">
      <Card flush>
        <Tabs value={tab} onChange={setTab} items={[{ value: "environments", label: "Environments · released vs running" }, { value: "map", label: "Product map" }]} />
      </Card>
      {tab === "environments" && (
        <Card title="Environment lineage" description="Pick an environment. The first lane is what the release declares (version tag → registries holding it); the second is what actually runs (the digest → registries holding it). Any difference between them is flagged as drift.">
          {focus ? <EnvironmentLineageView serviceId={focus.id} projectId={project.id} /> : <EmptyState title="Select a service">Pick a service in the navbar to see its environments.</EmptyState>}
        </Card>
      )}
      {tab === "map" && (<>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-3xl text-sm text-gray-700 dark:text-gray-300">
          <p><span className="font-medium text-gray-800 dark:text-white/90">Where does each version come from, where is it stored, where does it run — and how exposed is it?</span></p>
          <p className={`mt-1 ${muted}`}>Per service: <b>source</b> → <b>releases</b> (versions, with their commit) → <b>registries</b> holding each release's image (tags, digest, findings) → <b>environments</b> running it. Builds of <code>main</code> without a release hang off the service. Hover a card to follow its path; the risk score below each service is computed from exactly these links.</p>
        </div>
        <button type="button" className={outlineButton} disabled={recompute.isPending} onClick={() => recompute.mutate()}>{recompute.isPending ? "Computing…" : "Recompute risk"}</button>
      </div>
      {graph.isLoading ? <p className={`text-sm ${muted}`}>Loading…</p> : serviceNodes.length === 0 ? <Card flush><EmptyState title="No service yet">Create a service and attach its repository to see the graph.</EmptyState></Card> : serviceNodes.map((s) => <ServiceGraph key={s.id} serviceNode={s} nodes={nodes} edges={edges} projectId={project.id} builtInHost={registryInfo.data?.host ?? null} />)}
      </>)}
    </div>
  );
}
