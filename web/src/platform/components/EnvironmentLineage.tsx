import Badge from "@/components/ui/badge/Badge";
import { useEnvironmentLineage, useEvaluateGate, useLatestGate, useRegistryInfo, useServiceDeployments } from "@/platform/api/hooks";
import type { LineageRegistry } from "@/platform/api/types";
import { formatDate, relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Link } from "react-router";
import { ENV_COLOR } from "./ServicePanel";
import { BrandIcon, registryBrandForHost } from "./EnvironmentManager";
import { FindingCounts } from "./FindingCounts";
import { EmptyState, ErrorNotice, muted, outlineButton } from "./ui";

const short = (s: string | null | undefined, n = 12) => (s ? s.slice(0, n) : "—");
const dg = (d: string | null | undefined) => (d ? d.replace(/^sha256:/, "").slice(0, 12) : "—");

/** A card in a lane. */
function Node({ title, icon, children, tone = "default", className }: { title: ReactNode; icon?: ReactNode; children?: ReactNode; tone?: "default" | "good" | "bad" | "muted"; className?: string }) {
  return (
    <div className={cn("min-w-52 max-w-72 flex-1 rounded-xl border bg-white px-3.5 py-3 shadow-theme-xs dark:bg-white/3", tone === "bad" ? "border-error-300 dark:border-error-500/50" : tone === "good" ? "border-success-300 dark:border-success-500/40" : "border-gray-200 dark:border-gray-800", tone === "muted" && "opacity-60", className)}>
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-white/90">{icon}<span className="truncate">{title}</span></p>
      <div className={`mt-1 space-y-0.5 text-xs ${muted}`}>{children}</div>
    </div>
  );
}
const Arrow = () => <div className="flex shrink-0 items-center px-1 text-gray-300 dark:text-gray-700" aria-hidden="true"><svg width="28" height="16" viewBox="0 0 28 16"><path d="M0 8h22m-6-6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></div>;
const Lane = ({ title, hint, children }: { title: string; hint: string; children: ReactNode }) => (
  <div>
    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{title} <span className="font-normal normal-case tracking-normal">· {hint}</span></p>
    <div className="flex items-stretch gap-1 overflow-x-auto pb-2">{children}</div>
  </div>
);

function RegistryStack({ items, runningDigest, projectId, emptyText }: { items: LineageRegistry[]; runningDigest?: string | null; projectId: string; emptyText: string }) {
  const registryInfo = useRegistryInfo();
  if (!items.length) return <Node title="No registry" tone="muted">{emptyText}</Node>;
  return (
    <div className="flex min-w-60 max-w-80 flex-1 flex-col gap-2">
      {items.some((r) => r.deployedFrom) && items.length > 1 && <p className="text-[11px] font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400">Runs from · same digest also present in</p>}
      {items.map((r) => {
        const reg = registryBrandForHost(r.image, registryInfo.data?.host ?? null);
        const differs = !!runningDigest && !!r.digest && r.digest !== runningDigest;
        return (
          <Node key={r.image} title={<span className="flex items-center gap-2">{reg.label}{r.deployedFrom && <Badge size="sm" color="success">deployed from</Badge>}</span>} icon={<BrandIcon name={reg.brand} className="size-5" />} tone={differs ? "bad" : r.lastError ? "bad" : "default"}>
            <p className="truncate font-mono" title={r.image}>{r.repository || r.image}</p>
            <p className="flex flex-wrap gap-1">{r.tags.slice(0, 4).map((t) => <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-700 dark:bg-white/5 dark:text-gray-300" title={t}>{/^[0-9a-f]{12,}/i.test(t) ? t.slice(0, 10) + t.replace(/^[0-9a-f]+/i, "") : t}</span>)}{r.tags.length > 4 && <span>+{r.tags.length - 4}</span>}</p>
            <p className={cn("font-mono", differs && "text-error-500")} title={r.digest ?? ""}>{dg(r.digest)}{differs ? " ≠ running" : ""}</p>
            {r.sbom ? <Link to={`/projects/${projectId}/sboms/${r.sbom.id}`} className="block hover:text-brand-500"><FindingCounts counts={r.sbom.findings} /></Link> : <p>not scanned</p>}
            {r.lastError && <p className="text-error-500">sync failed</p>}
          </Node>
        );
      })}
    </div>
  );
}

export function EnvironmentLineageView({ serviceId, projectId }: { serviceId: string; projectId: string }) {
  const envs = useServiceDeployments(serviceId);
  const [params, setParams] = useSearchParams();
  const selected = params.get("env");
  const setSelected = (id: string) => setParams((p) => { p.set("env", id); return p; }, { replace: true });
  const list = envs.data?.environments ?? [];
  useEffect(() => { if ((!selected || !list.some((e) => e.id === selected)) && list.length) setSelected(list.find((e) => e.kind === "production")?.id ?? list[0].id); }, [list, selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const lineage = useEnvironmentLineage(selected ?? undefined);
  const gate = useLatestGate(selected ?? undefined);
  const evaluate = useEvaluateGate();
  const d = lineage.data;
  if (envs.error) return <ErrorNotice error={envs.error} />;
  if (!list.length) return <EmptyState title="No environment yet">Declare environments on the Services page first.</EmptyState>;
  return (
    <div className="space-y-6">
      {/* environment selector */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {list.map((e) => {
          const on = e.id === selected;
          return (
            <button key={e.id} type="button" onClick={() => setSelected(e.id)} className={cn("rounded-xl border px-4 py-3 text-start transition", on ? "border-brand-500 bg-brand-50/50 ring-2 ring-brand-500/20 dark:bg-brand-500/5" : "border-gray-200 hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700")}>
              <p className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-white/90">{e.name}<Badge size="sm" color={ENV_COLOR[e.kind] ?? "light"}>{e.kind}</Badge>{e.internetFacing && <span className={`text-[11px] font-normal ${muted}`}>internet-facing</span>}{e.settings?.protected === true && <span className={`text-[11px] font-normal ${muted}`}>· protected</span>}</p>
              <p className={`mt-0.5 flex items-center gap-2 text-xs ${muted}`}>{e.current ? <>{e.current.version ?? `build ${short(e.current.imageRef?.split("@")[1]?.replace("sha256:", "") ?? e.current.imageRef, 12)}`} · since {relativeTime(e.current.deployedAt)}{Date.now() - new Date(e.current.deployedAt).getTime() < 120_000 && <span className="inline-flex items-center gap-1 text-success-600"><span className="size-1.5 animate-pulse rounded-full bg-success-500" />just deployed</span>}</> : "nothing deployed"}</p>
            </button>
          );
        })}
      </div>

      {lineage.error ? <ErrorNotice error={lineage.error} /> : !d ? <p className={`text-sm ${muted}`}>Loading…</p> : (
        <>
          {/* gate */}
          {(gate.data || d.running) && (
            <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm", gate.data?.result === "fail" ? "border-error-200 bg-error-50 dark:border-error-500/30 dark:bg-error-500/10" : gate.data?.result === "warn" ? "border-warning-200 bg-warning-50 dark:border-warning-500/30 dark:bg-warning-500/10" : "border-gray-200 dark:border-gray-800")}>
              <span className="min-w-0">
                <span className="font-medium text-gray-800 dark:text-white/90">Policy gate: </span>
                {gate.data ? <>{gate.data.result === "pass" ? <Badge size="sm" color="success">passed</Badge> : gate.data.result === "warn" ? <Badge size="sm" color="warning">warnings</Badge> : <Badge size="sm" color="error">failed</Badge>} <span className={muted}>{gate.data.subject.version ?? gate.data.subject.imageRef?.split("/").slice(-1)[0]?.slice(0, 40) ?? gate.data.subject.ref?.slice(0, 12)} · {relativeTime(gate.data.evaluatedAt)}{gate.data.actor ? ` · ${gate.data.actor}` : ""}</span>{gate.data.violations.length > 0 && <ul className={`mt-1 space-y-0.5 text-xs ${muted}`}>{gate.data.violations.map((v, i) => <li key={i}>{v.action === "block" ? "✗" : "!"} {v.policyName}: {v.message}</li>)}</ul>}</> : <span className={muted}>not evaluated yet</span>}
              </span>
              {d.running && <button type="button" className={outlineButton} disabled={evaluate.isPending} onClick={() => evaluate.mutate({ environmentId: d.environment.id, ...(d.running!.imageRef ? { imageRef: d.running!.imageRef } : { version: d.running!.version ?? undefined }) })}>{evaluate.isPending ? "Evaluating…" : "Evaluate what runs now"}</button>}
            </div>
          )}

          {/* drift */}
          {d.drift.length > 0 ? (
            <div className="space-y-2">
              {d.drift.map((x) => (
                <div key={x.code + x.message} className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", x.level === "error" ? "border-error-200 bg-error-50 text-error-700 dark:border-error-500/30 dark:bg-error-500/10 dark:text-error-400" : x.level === "warning" ? "border-warning-200 bg-warning-50 text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-400" : "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-white/3 dark:text-gray-300")}>
                  <span className="mt-0.5 font-semibold uppercase text-[11px] tracking-wide">{x.level === "error" ? "Drift" : x.level === "warning" ? "Check" : "Note"}</span><span>{x.message}</span>
                </div>
              ))}
            </div>
          ) : d.running ? <div className="rounded-xl border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-400">Released and running images agree: {d.environment.name} runs exactly what {d.release ? `release ${d.release.version}` : "its build"} declares, and it is scanned.</div> : null}

          {!d.running ? <EmptyState title={`Nothing is deployed to ${d.environment.name}`}>Deploy with the CI workflow (`secops deploy` / `secops promote`) or from Environments → Manage → Deploy image.</EmptyState> : (
            <>
              {/* Lane 1: released */}
              <Lane title={d.declared ? "Released" : "Built"} hint={d.declared ? `what version ${d.release!.version} declares` : d.release ? `a build of commit ${short(d.release.commitSha, 8)} — same commit as release ${d.release.version}, but the deployment did not declare a version` : "no release is linked to this deployment"}>
                <Node title={d.repository?.fullName ?? "No repository"} icon={<BrandIcon name={d.repository?.htmlUrl?.includes("gitlab") ? "gitlab" : "github"} className="size-5" />} tone={d.repository ? "default" : "muted"}>
                  <p>{d.repository?.defaultBranch ?? "—"}</p>
                  {d.release?.commitSha && <p className="font-mono">{d.release.htmlUrl ? <a href={d.release.htmlUrl} target="_blank" rel="noreferrer" className="hover:text-brand-500">{short(d.release.commitSha, 10)}</a> : short(d.release.commitSha, 10)}</p>}
                </Node>
                <Arrow />
                <Node title={d.declared && d.release ? `Release ${d.release.version}` : d.release ? `Build of ${short(d.release.commitSha, 8)}` : `Version ${d.running.version ?? "—"}`} tone={d.release ? "default" : /^v?\d+(\.\d+)+/.test(d.running.version ?? "") ? "bad" : "muted"}>
                  {d.release ? <>
                    <p>{d.release.tag ?? d.release.version} · {d.release.source.replace(/_/g, " ")}{d.release.releasedAt ? ` · ${formatDate(d.release.releasedAt)}` : ""}</p>
                    {d.release.sbom ? <Link to={`/projects/${projectId}/sboms/${d.release.sbom.id}`} className="block hover:text-brand-500">source SBOM · <FindingCounts counts={d.release.sbom.findings} /></Link> : <p>no source SBOM</p>}
                  </> : /^v?\d+(\.\d+)+/.test(d.running.version ?? "") ? <p>no release record — deploy with <code>--version</code> and <code>--commit</code></p> : <p>a build of <code>main</code>, not a release</p>}
                </Node>
                <Arrow />
                <RegistryStack items={d.declared ? (d.release?.registries ?? []) : d.running.registries} runningDigest={d.declared ? d.running.digest : undefined} projectId={projectId} emptyText="the version tag is not known in any registry yet" />
                <Arrow />
                <Node title={d.environment.name} icon={<Badge size="sm" color={ENV_COLOR[d.environment.kind] ?? "light"}>{d.environment.kind}</Badge>}>
                  <p>{d.environment.internetFacing ? "internet-facing" : "internal"}{d.environment.protected ? " · protected" : ""}</p>
                </Node>
              </Lane>

              {/* Lane 2: running */}
              <Lane title="Running now" hint={d.running.inferred ? "inferred from the release — the deployment named only a version" : "what actually runs, identified by its digest"}>
                <Node title={d.repository?.fullName ?? "No repository"} icon={<BrandIcon name={d.repository?.htmlUrl?.includes("gitlab") ? "gitlab" : "github"} className="size-5" />} tone={d.repository ? "default" : "muted"}>
                  <p>commit <span className="font-mono">{short(d.running.commitSha, 10)}</span></p>
                </Node>
                <Arrow />
                <Node title={<span className="font-mono">{dg(d.running.digest)}{d.running.inferred ? <span className={`ms-2 font-sans text-[11px] ${muted}`}>inferred</span> : null}</span>} icon={<BrandIcon name="docker" className="size-5" />} tone={d.running.digest ? "default" : "bad"}>
                  <p>{d.running.builtAt ? `built ${relativeTime(d.running.builtAt)}` : "build time unknown"}</p>
                  <p className="flex flex-wrap gap-1">{d.running.tags.slice(0, 4).map((t) => <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-700 dark:bg-white/5 dark:text-gray-300" title={t}>{/^[0-9a-f]{12,}/i.test(t) ? t.slice(0, 10) + t.replace(/^[0-9a-f]+/i, "") : t}</span>)}</p>
                  {d.running.sbom ? <Link to={`/projects/${projectId}/sboms/${d.running.sbom.id}`} className="block hover:text-brand-500">SBOM {d.running.sbom.componentCount} components · <FindingCounts counts={d.running.sbom.findings} /></Link> : <p className="text-warning-600">not scanned</p>}
                </Node>
                <Arrow />
                <RegistryStack items={d.running.registries} projectId={projectId} emptyText="no known registry holds this digest" />
                <Arrow />
                <Node title={d.environment.name} icon={<Badge size="sm" color={ENV_COLOR[d.environment.kind] ?? "light"}>{d.environment.kind}</Badge>} tone="good">
                  <p>since {relativeTime(d.running.deployedAt)} · {d.running.source}</p>
                  <p className="truncate font-mono" title={d.running.imageRef ?? ""}>{d.running.imageRef ? d.running.imageRef.split("/").slice(-1)[0].slice(0, 40) : "—"}</p>
                </Node>
              </Lane>
            </>
          )}

          {/* history */}
          {d.history.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Deployment history</p>
              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">
                {d.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                    <span className={`w-24 ${muted}`}>{relativeTime(h.deployedAt)}</span>
                    <span className="w-32 font-medium text-gray-800 dark:text-white/90">{h.version ?? "build"}</span>
                    <span className={`min-w-0 flex-1 truncate font-mono text-xs ${muted}`}>{h.imageRef ?? "—"}</span>
                    <span className={`text-xs ${muted}`}>{h.source}</span>
                    {h.supersededAt ? <Badge size="sm" color="light">superseded</Badge> : <Badge size="sm" color="success">current</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
