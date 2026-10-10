import { CodeBlock } from "./CodeBlock";
import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { PlusIcon } from "@/icons";
import { isForbidden } from "@/platform/api/client";
import { useCreateRunnerPool, useDeleteRunnerPool, useRegistrationToken, useRemoveRunner, useRunnerAgent, useRunnerPools } from "@/platform/api/hooks";
import type { RegistrationToken, Runner, RunnerPool, RunnerStatus, ScopeType } from "@/platform/api/types";
import { relativeTime, SLUG_PATTERN, slugify } from "@/platform/format";
import { cn } from "@/utils";
import { useState, type FormEvent } from "react";
import { Kpi } from "./Dashboard";
import { Card, dangerLink, EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton, Tabs, td, th, trBorder } from "./ui";

const STATUS_COLOR: Record<RunnerStatus, "success" | "info" | "light" | "warning"> = { online: "success", busy: "info", offline: "light", draining: "warning" };
const LEVEL: Record<ScopeType, string> = { ORGANIZATION: "organization", WORKSPACE: "workspace", TEAM: "team", PROJECT: "project", SERVICE: "service", ENVIRONMENT: "environment" };

const ENVIRONMENTS: { key: keyof Pick<RegistrationToken, "docker" | "compose" | "kubernetes" | "local">; title: string; text: string }[] = [
  { key: "docker", title: "Docker", text: "One container on any machine with Docker: a build server, a jump host, a laptop." },
  { key: "compose", title: "Docker Compose", text: "The same as a Compose service, easy to keep in a repository." },
  { key: "kubernetes", title: "Kubernetes", text: "A Deployment in your cluster: place it where it can reach your git host and registry." },
  { key: "local", title: "From source", text: "For platform development: runs the agent from this repository." },
];

function RegisterDialog({ pool, onClose }: { pool: RunnerPool; onClose: () => void }) {
  const token = useRegistrationToken();
  const [data, setData] = useState<RegistrationToken | null>(null);
  const [env, setEnv] = useState<(typeof ENVIRONMENTS)[number]["key"]>(window.location.hostname === "localhost" ? "local" : "docker");
  if (!data && !token.isPending && !token.error && !token.isSuccess) token.mutate(pool.id, { onSuccess: setData });
  return (
    <Modal isOpen onClose={onClose} className="max-w-190 p-6 lg:p-10">
      <h4 className="mb-1 text-lg font-semibold text-gray-800 dark:text-white/90">Register a runner</h4>
      <p className={`mb-5 text-sm ${muted}`}>Pool <strong className="text-gray-800 dark:text-white/90">{pool.name}</strong> ({LEVEL[pool.scope.type]} {pool.scope.name}). The runner only makes outbound HTTPS connections to the platform — no inbound port, no public IP, works behind NAT and proxies. Put it where your code, registry and clusters are reachable.</p>
      {token.error ? <ErrorNotice error={token.error} /> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {ENVIRONMENTS.map((e) => (
          <button key={e.key} type="button" onClick={() => setEnv(e.key)} className={cn("rounded-xl border p-3 text-start", env === e.key ? "border-brand-400 bg-brand-50/40 dark:border-brand-500/60 dark:bg-brand-500/5" : "border-gray-200 hover:border-gray-300 dark:border-gray-800")}>
            <span className="block text-sm font-medium text-gray-800 dark:text-white/90">{e.title}</span>
            <span className={`block text-xs ${muted}`}>{e.text}</span>
          </button>
        ))}
      </div>
      {data && (
        <div className="mt-5 space-y-3">
          <p className="text-sm text-gray-700 dark:text-gray-300">1. Run this where the runner should live:</p>
          <CodeBlock code={data[env]} />
          <div className="flex items-center justify-between gap-3">
            <span className={`text-xs ${muted}`}>Token valid {relativeTime(data.expiresAt).replace("in ", "for ")}, single use. Add tags with <code>RUNNER_TAGS=gpu,internal</code>.</span>
            <button type="button" className={outlineButton} onClick={() => void navigator.clipboard?.writeText(data[env])}>Copy</button>
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">2. The runner appears in the list within seconds as <em>online</em>. Jobs whose tags it satisfies are picked up automatically.</p>
        </div>
      )}
      <div className="mt-6 flex justify-end"><button type="button" className={primaryButton} onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function NewPoolDialog({ level, pending, error, onSubmit, onClose }: { level: string; pending: boolean; error: unknown; onSubmit: (d: { slug: string; name: string; description?: string; tags: string[] }) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit({ slug, name, description: description || undefined, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }); };
  return (
    <Modal isOpen onClose={onClose} className="max-w-150 p-6 lg:p-10">
      <form onSubmit={submit} className="space-y-5">
        <h4 className="text-lg font-semibold text-gray-800 dark:text-white/90">New runner pool</h4>
        <p className={`text-sm ${muted}`}>A pool groups runners with the same purpose or location. This one belongs to the {level} and serves every project below it.</p>
        <div><Label htmlFor="p-name">Name</Label><input id="p-name" autoFocus required className={inputClass} placeholder="Build servers Frankfurt" value={name} onChange={(e) => { setName(e.target.value); setSlug(slugify(e.target.value)); }} /></div>
        <div><Label htmlFor="p-slug">Slug</Label><input id="p-slug" required pattern={SLUG_PATTERN} className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)} /></div>
        <div><Label htmlFor="p-tags">Tags</Label><input id="p-tags" className={inputClass} placeholder="linux, docker, internal" value={tags} onChange={(e) => setTags(e.target.value)} /><p className={`mt-1.5 text-xs ${muted}`}>Every runner in the pool advertises these. Jobs can require tags to land on specific runners (e.g. <code>internal</code> for private networks).</p></div>
        <div><Label htmlFor="p-desc">Description</Label><input id="p-desc" className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={pending}>{pending ? "Creating…" : "Create pool"}</button></div>
      </form>
    </Modal>
  );
}

function RunnerDrawer({ runner, pool, onClose }: { runner: Runner; pool: RunnerPool; onClose: () => void }) {
  const m = runner.metadata;
  return (
    <Modal isOpen onClose={onClose} className="max-w-150 p-6 lg:p-8">
      <h4 className="flex items-center gap-3 text-lg font-semibold text-gray-800 dark:text-white/90">{runner.name} <Badge size="sm" color={STATUS_COLOR[runner.status]}>{runner.status}</Badge></h4>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div><dt className={`text-xs ${muted}`}>Pool</dt><dd className="text-gray-800 dark:text-white/90">{pool.name} · {LEVEL[pool.scope.type]} {pool.scope.name}</dd></div>
        <div><dt className={`text-xs ${muted}`}>Tags</dt><dd>{[...pool.tags, ...runner.tags].map((t) => <Badge key={t} size="sm" color="light">{t}</Badge>)}</dd></div>
        <div><dt className={`text-xs ${muted}`}>Host</dt><dd className="text-gray-800 dark:text-white/90">{String(m.hostname ?? "—")} · {String(m.os ?? "")}/{String(m.arch ?? "")}</dd></div>
        <div><dt className={`text-xs ${muted}`}>Capabilities</dt><dd className="text-gray-800 dark:text-white/90">{m.docker ? "Docker available" : "no Docker"} · agent v{runner.version ?? "?"}</dd></div>
        <div><dt className={`text-xs ${muted}`}>Last heartbeat</dt><dd className="text-gray-800 dark:text-white/90">{runner.lastHeartbeatAt ? relativeTime(runner.lastHeartbeatAt) : "never"}</dd></div>
        <div><dt className={`text-xs ${muted}`}>Registered</dt><dd className="text-gray-800 dark:text-white/90">{relativeTime(runner.registeredAt)}</dd></div>
        <div className="col-span-2"><dt className={`text-xs ${muted}`}>Current job</dt><dd className="text-gray-800 dark:text-white/90">{runner.currentJobId ?? "idle"}</dd></div>
      </dl>
      <div className="mt-6 flex justify-end"><button type="button" className={outlineButton} onClick={onClose}>Close</button></div>
    </Modal>
  );
}

/** Runners at a level: tab "Runners" (every runner usable here) and tab "Pools" (owned + inherited). */
export function RunnersPanel({ organizationId, scopeType, scopeId, scopeName, chainRefs }: { organizationId: string; scopeType: ScopeType; scopeId: string; scopeName: string; chainRefs: { type: ScopeType; id: string }[] }) {
  const pools = useRunnerPools(organizationId);
  const create = useCreateRunnerPool(organizationId);
  const remove = useDeleteRunnerPool(organizationId);
  const removeRunner = useRemoveRunner(organizationId);
  const [tab, setTab] = useState<"runners" | "pools">("runners");
  const agent = useRunnerAgent();
  const [dialog, setDialog] = useState(false);
  const [register, setRegister] = useState<RunnerPool | null>(null);
  const [drawer, setDrawer] = useState<{ runner: Runner; pool: RunnerPool } | null>(null);
  const refs = new Set(chainRefs.map((r) => `${r.type}:${r.id}`));
  // the cell's managed pool serves every level (read-only: operated by the platform)
  const visible = (pools.data ?? []).filter((p) => p.managed || refs.has(`${p.scopeType}:${p.scopeId}`)).map((p) => ({ ...p, inherited: !!p.managed || !(p.scopeType === scopeType && p.scopeId === scopeId) }));
  const runnersHere = visible.flatMap((p) => p.runners.map((r) => ({ runner: r, pool: p })));
  const online = runnersHere.filter((x) => x.runner.status !== "offline").length;
  const own = visible.filter((p) => !p.inherited);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:gap-4">
        <Kpi label="Runners available" value={runnersHere.length} />
        <Kpi label="Online" value={online} tone={runnersHere.length && !online ? "bad" : online ? "good" : "default"} />
        <Kpi label="Busy" value={runnersHere.filter((x) => x.runner.status === "busy").length} />
        <Kpi label="Pools at this level" value={own.length} />
      </div>

      <Card
        title="Runners"
        description={`Runners execute pipelines close to your code. Everything usable by the ${LEVEL[scopeType]} ${scopeName}: pools created here, pools inherited from above, and the platform's managed runners.`}
        flush
        actions={
          <div className="flex items-center gap-3">
            {own.length > 0 && <button type="button" className={outlineButton} onClick={() => setRegister(own[0]!)}>Register runner</button>}
            <button type="button" className={primaryButton} onClick={() => setDialog(true)} disabled={isForbidden(pools.error)}><PlusIcon className="size-5" /> New pool</button>
          </div>
        }
      >
        <Tabs value={tab} onChange={setTab} items={[{ value: "runners", label: `Runners (${runnersHere.length})` }, { value: "pools", label: `Pools (${visible.length})` }]} />
        {isForbidden(pools.error) ? <EmptyState title="Not visible with your role" /> : pools.error ? <div className="p-4"><ErrorNotice error={pools.error} /></div> : tab === "runners" ? (
          runnersHere.length === 0 ? (
            <EmptyState title="No runner yet">{own.length ? "Register one with a single command — Register runner above." : "Create a pool first, then register a runner in it."}</EmptyState>
          ) : (
            <table className="min-w-full">
              <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Runner</th><th className={th}>Status</th><th className={th}>Pool</th><th className={th}>Tags</th><th className={th}>Host</th><th className={th}>Heartbeat</th><th className={th} /></tr></thead>
              <tbody>
                {runnersHere.map(({ runner: r, pool }) => (
                  <tr key={r.id} className={`${trBorder} cursor-pointer hover:bg-gray-50 dark:hover:bg-white/2`} onClick={() => setDrawer({ runner: r, pool })}>
                    <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{r.name}</span> <span className={`text-xs ${muted}`}>v{r.version ?? "?"}</span>{agent.data && r.version && r.version !== agent.data.latestVersion && <Badge size="sm" color="warning">update to v{agent.data.latestVersion}</Badge>}</td>
                    <td className={td}><Badge size="sm" color={STATUS_COLOR[r.status]}>{r.status}</Badge>{r.currentJobId && <span className={`ms-2 text-xs ${muted}`}>running a job</span>}</td>
                    <td className={`${td} ${muted}`}>{pool.name}{pool.managed ? <span className="ms-1 text-xs">(managed)</span> : pool.inherited && <span className="ms-1 text-xs">(inherited)</span>}</td>
                    <td className={td}>{[...pool.tags, ...r.tags].map((t) => <Badge key={t} size="sm" color="light">{t}</Badge>)}</td>
                    <td className={`${td} ${muted}`}>{String(r.metadata.hostname ?? "")} · {String(r.metadata.os ?? "")}/{String(r.metadata.arch ?? "")}{r.metadata.docker ? " · docker" : ""}</td>
                    <td className={`${td} ${muted}`}>{r.lastHeartbeatAt ? relativeTime(r.lastHeartbeatAt) : "never"}</td>
                    <td className={`${td} text-end`} onClick={(e) => e.stopPropagation()}>{!pool.inherited && <button type="button" className={dangerLink} onClick={() => { if (window.confirm(`Remove runner ${r.name}? The agent will need a new registration token.`)) removeRunner.mutate(r.id); }}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : visible.length === 0 ? (
          <EmptyState title="No pool yet">A pool belongs to a level and serves everything below it. Create one here, or at the organization to share runners with everyone.</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
            {visible.map((pool) => (
              <div key={pool.id} className={cn("rounded-2xl border p-4", pool.inherited ? "border-dashed border-gray-300 dark:border-gray-700" : "border-gray-200 dark:border-gray-800")}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-gray-800 dark:text-white/90">{pool.name} {pool.managed ? <Badge size="sm" color="primary">managed by the platform</Badge> : pool.inherited && <Badge size="sm" color="light">inherited</Badge>}</p>
                    <p className={`text-xs ${muted}`}>{pool.managed ? "Runs in this cell · serves every organization and project" : `${LEVEL[pool.scope.type]} ${pool.scope.name} · ${pool.slug}`}</p>
                  </div>
                  <span className={`text-sm ${muted}`}>{pool.runners.filter((r) => r.status !== "offline").length}/{pool.runners.length} online</span>
                </div>
                {pool.description && <p className={`mt-2 text-sm ${muted}`}>{pool.description}</p>}
                {pool.managed && pool.runners.length === 0 && <p className={`mt-2 text-xs ${muted}`}>No managed runner has registered yet: the cell operator enables them in the Helm chart (managedRunners.replicas).</p>}
                <div className="mt-2">{pool.tags.length ? pool.tags.map((t) => <Badge key={t} size="sm" color="info">{t}</Badge>) : <span className={`text-xs ${muted}`}>no tags</span>}</div>
                {!pool.inherited && (
                  <div className="mt-4 flex gap-3">
                    <button type="button" className={outlineButton} onClick={() => setRegister(pool)}>Register runner</button>
                    <button type="button" className={dangerLink} onClick={() => { if (window.confirm(`Delete pool ${pool.name} and its ${pool.runners.length} runners?`)) remove.mutate(pool.id); }}>Delete</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {(remove.error || removeRunner.error) ? <div className="p-4"><ErrorNotice error={remove.error ?? removeRunner.error} /></div> : null}
      </Card>

      {dialog && <NewPoolDialog level={`${LEVEL[scopeType]} ${scopeName}`} pending={create.isPending} error={create.error} onClose={() => setDialog(false)} onSubmit={(d) => create.mutate({ ...d, scopeType, scopeId }, { onSuccess: (pool) => { setDialog(false); setRegister(pool); } })} />}
      {register && <RegisterDialog pool={register} onClose={() => setRegister(null)} />}
      {drawer && <RunnerDrawer runner={drawer.runner} pool={drawer.pool} onClose={() => setDrawer(null)} />}
    </div>
  );
}
