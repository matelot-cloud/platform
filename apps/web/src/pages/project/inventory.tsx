import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { PlusIcon } from "@/icons";
import { useAddImage, useCreateJob, useCreateRelease, usePendingSboms, useProjectIntegrations, useRegistryInfo, useRemoveImage, useSboms, useServiceDeployments, useServiceInventory, useSyncImage, useSyncReleases } from "@/platform/api/hooks";
import type { Deployment, EnvironmentKind, Service, ServiceInventory } from "@/platform/api/types";
import { BrandIcon, EnvironmentManager, registryBrandForHost } from "@/platform/components/EnvironmentManager";
import { FindingCounts } from "@/platform/components/FindingCounts";
import { Spinner } from "@/platform/header/ActivityIndicator";
import { RegistryCard } from "@/platform/components/RegistryCard";
import { ENV_COLOR } from "@/platform/components/ServicePanel";
import { Card, EmptyState, ErrorNotice, inputClass, linkButton, muted, outlineButton, primaryButton, SelectField, Tabs, td, th, Toolbar, trBorder } from "@/platform/components/ui";
import { formatDate, relativeTime } from "@/platform/format";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useProject } from "./layout";

const SOURCE_LABEL: Record<string, string> = { git_tag: "git tag", github_release: "GitHub release", gitlab_release: "GitLab release", manual: "manual", api: "API", cli: "CLI", kubernetes: "Kubernetes", registry: "registry push" };

// ------------------------------------------------------------------ releases
function EnvChips({ environments }: { environments: { id: string; name: string; kind: EnvironmentKind }[] }) {
  if (!environments.length) return <span className={`text-xs ${muted}`}>not deployed</span>;
  return <span className="flex flex-wrap gap-1">{environments.map((e) => <Badge key={e.id} size="sm" color={ENV_COLOR[e.kind] ?? "light"}>{e.name}</Badge>)}</span>;
}

function ReleaseCard({ r, projectId, service, builtInHost }: { r: ServiceInventory["releases"][number]; projectId: string; service: Service; builtInHost: string | null }) {
  const createJob = useCreateJob(projectId);
  const { organization } = useProject();
  const pending = usePendingSboms(organization.id);
  const generating = pending.versions.has(r.version) || (!!r.tag && pending.versions.has(r.tag));
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (v: string) => { void navigator.clipboard?.writeText(v); setCopied(v); setTimeout(() => setCopied(null), 1200); };
  const source = r.source === "git_tag" ? { brand: (r.htmlUrl?.includes("gitlab") ? "gitlab" : r.htmlUrl?.includes("github") ? "github" : "git") as "gitlab" | "github" | "git", label: "git tag" } : r.source === "github_release" ? { brand: "github" as const, label: "GitHub release" } : r.source === "gitlab_release" ? { brand: "gitlab" as const, label: "GitLab release" } : { brand: "git" as const, label: SOURCE_LABEL[r.source] ?? r.source };
  return (
    <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <BrandIcon name={source.brand} className="mt-0.5 size-9" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-gray-800 dark:text-white/90">{r.version}</span>
              {r.environments.length > 0 ? <EnvChips environments={r.environments} /> : <span className={`text-xs ${muted}`}>not deployed</span>}
            </div>
            <p className={`text-xs ${muted}`}>{source.label}{r.tag ? <> · {r.htmlUrl ? <a href={r.htmlUrl} target="_blank" rel="noreferrer" className="hover:text-brand-500">{r.tag}</a> : r.tag}</> : null}{r.commitSha && <> · <span className="font-mono">{r.commitSha.slice(0, 12)}</span> <button type="button" className="text-[11px] font-medium text-brand-500 hover:text-brand-600" onClick={() => copy(r.commitSha!)}>{copied === r.commitSha ? "copied" : "copy"}</button></>}{r.releasedAt && <> · {formatDate(r.releasedAt)}</>}</p>
            {r.notes && <p className={`mt-1 max-w-2xl truncate text-xs ${muted}`} title={r.notes}>{r.notes}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {r.sbom && <FindingCounts counts={r.sbom.findings} />}
          {generating ? <span className="inline-flex items-center gap-2 text-sm text-brand-500"><Spinner />Generating SBOM…</span> : r.sbom ? <Link to={`/projects/${projectId}/sboms/${r.sbom.id}`} className={outlineButton}>SBOM · {r.sbom.componentCount} components</Link> : <button type="button" className={outlineButton} disabled={createJob.isPending} onClick={() => createJob.mutate({ serviceId: service.id, type: "sbom", payload: { target: "source", ref: r.tag ?? r.version, version: r.version } })}>{createJob.isPending ? "Queuing…" : "Generate SBOM"}</button>}
        </div>
      </div>
      <div className="border-t border-gray-100 px-5 py-3 dark:border-gray-800">
        {r.images.length === 0 ? <p className={`text-xs ${muted}`}>No image linked yet — an image tagged <span className="font-mono">{r.version}</span>, <span className="font-mono">v{r.version}</span> or with this commit links automatically.</p> : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {r.images.map((t) => {
              const reg = registryBrandForHost(t.image ?? "", builtInHost);
              const isSha = /^[0-9a-f]{12,40}$/i.test(t.tag);
              return (
                <li key={t.id} className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2 dark:border-gray-800">
                  <BrandIcon name={reg.brand} className="size-6" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-gray-800 dark:text-white/90" title={`${t.image}:${t.tag}`}>{(t.image ?? "").split("/").slice(1).join("/") || t.image}:{isSha ? t.tag.slice(0, 12) : t.tag}</span>
                    <span className={`block truncate font-mono text-[11px] ${muted}`}>{reg.label}{t.digest ? ` · ${t.digest.slice(7, 19)}` : ""}{t.sbom ? ` · SBOM ${t.sbom.componentCount}` : ""}</span>
                  </span>
                  <EnvChips environments={t.environments ?? []} />
                  <button type="button" className="text-[11px] font-medium text-brand-500 hover:text-brand-600" onClick={() => copy(`${t.image}@${t.digest ?? t.tag}`)}>{copied === `${t.image}@${t.digest ?? t.tag}` ? "copied" : "copy ref"}</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {createJob.error ? <div className="px-5 pb-3"><ErrorNotice error={createJob.error} /></div> : null}
    </div>
  );
}

function Releases({ service, projectId }: { service: Service; projectId: string }) {
  const inventory = useServiceInventory(service.id);
  const registryInfo = useRegistryInfo();
  const releases = inventory.data?.releases ?? [];
  const sync = useSyncReleases(service.id);
  const create = useCreateRelease(service.id);
  const [dialog, setDialog] = useState(false);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [showAll, setShowAll] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate({ version, notes: notes || undefined }, { onSuccess: () => { setDialog(false); setVersion(""); setNotes(""); } }); };
  const visible = showAll ? releases : releases.slice(0, 8);
  return (
    <>
      <Toolbar actions={<><button type="button" className={outlineButton} disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? "Syncing…" : "Sync from repositories"}</button><button type="button" className={primaryButton} onClick={() => setDialog(true)}><PlusIcon className="size-4" /> Record release</button></>}>
        Versions of {service.name}: git tags and GitHub/GitLab releases of the attached repositories, or recorded from CI. Each release shows its commit, the images built from it and where it runs.
      </Toolbar>
      {sync.data && <p className={`px-6 pb-2 text-xs ${muted}`}>{sync.data.seen} tags seen, {sync.data.created} new{sync.data.errors.length ? ` · ${sync.data.errors.join("; ")}` : ""}</p>}
      {(sync.error || create.error) ? <div className="px-6 pb-3"><ErrorNotice error={sync.error ?? create.error} /></div> : null}
      {releases.length === 0 ? <EmptyState title="No release yet">Tag a commit (v4.2.0) and sync, or record one.</EmptyState> : (
        <div className="space-y-4 px-6 pb-6">
          {visible.map((r) => <ReleaseCard key={r.id} r={r} projectId={projectId} service={service} builtInHost={registryInfo.data?.host ?? null} />)}
          {releases.length > 8 && <button type="button" className="w-full rounded-xl border border-dashed border-gray-300 py-2.5 text-sm font-medium text-brand-500 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-white/3" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show 8 most recent" : `Show all ${releases.length} releases`}</button>}
        </div>
      )}
      {dialog && (
        <Modal isOpen title={<>Record a release of {service.name}</>} onClose={() => setDialog(false)} className="max-w-150 p-6 lg:p-10">
          <form onSubmit={submit} className="space-y-5">
            <div><Label htmlFor="rel-v">Version</Label><input id="rel-v" required autoFocus className={inputClass} placeholder="4.3.0" value={version} onChange={(e) => setVersion(e.target.value)} /></div>
            <div><Label htmlFor="rel-n">Notes</Label><input id="rel-n" className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={() => setDialog(false)}>Cancel</button><button type="submit" className={primaryButton} disabled={create.isPending}>{create.isPending ? "Recording…" : "Record release"}</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ImageCard({ img, projectId, service, builtInHost, onSync, onRemove, syncing }: { img: ServiceInventory["images"][number]; projectId: string; service: Service; builtInHost: string | null; onSync: () => void; onRemove: () => void; syncing: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const sboms = useSboms(service.id);
  const createJob = useCreateJob(projectId);
  const { organization } = useProject();
  const pending = usePendingSboms(organization.id);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (v: string) => { void navigator.clipboard?.writeText(v); setCopied(v); setTimeout(() => setCopied(null), 1200); };
  const reg = registryBrandForHost(img.name, builtInHost);
  const [host, ...rest] = img.name.split("/");
  const repository = rest.join("/");
  const visible = showAll ? img.tags : img.tags.slice(0, 5);
  const running = img.tags.filter((t) => (t.environments ?? []).length > 0).length;
  const linked = img.tags.filter((t) => t.releaseVersion).length;
  const releaseHint = linked === 0 ? " (deploy a version like 1.4.2, or tag the commit as a release)" : "";
  return (
    <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <BrandIcon name={reg.brand} className="mt-0.5 size-9" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-mono text-sm font-semibold text-gray-800 dark:text-white/90">{repository || img.name}</span>
              <button type="button" className="text-xs font-medium text-brand-500 hover:text-brand-600" onClick={() => copy(img.name)}>{copied === img.name ? "copied" : "copy name"}</button>
            </div>
            <p className={`text-xs ${muted}`}>{reg.label} · <span className="font-mono">{host}</span></p>
            <p className={`mt-1 flex flex-wrap gap-x-3 text-xs ${muted}`}>
              <span>{img.tags.length} tag{img.tags.length === 1 ? "" : "s"}</span>
              <span title={linked === 0 ? "Builds deployed as sha-… are not releases. A tag becomes linked when its version tag or commit matches a release, or when a deployment names a release version." : undefined}>{linked} linked to releases{releaseHint}</span>
              <span>{running} running</span>
              <span>{img.lastSyncedAt ? `synced ${relativeTime(img.lastSyncedAt)}` : "never synced"}</span>
            </p>
            {img.lastError && <p className="mt-1 text-xs text-error-500">{img.lastError}</p>}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className={outlineButton} disabled={syncing} onClick={onSync}>{syncing ? "Syncing…" : "Sync tags"}</button>
          <button type="button" className={outlineButton} onClick={onRemove}>Remove</button>
        </div>
      </div>
      {img.tags.length > 0 && (
        <div className="border-t border-gray-100 dark:border-gray-800">
          <table className="min-w-full">
            <thead><tr><th className={th}>Tag</th><th className={th}>Digest</th><th className={th}>Release</th><th className={th}>Running in</th><th className={th}>Built</th><th className={th}>SBOM</th></tr></thead>
            <tbody>
              {visible.map((t) => {
                const b = (sboms.data ?? []).find((x) => x.imageTagId === t.id) ?? (t.digestSbom ? (sboms.data ?? []).find((x) => x.id === t.digestSbom!.id) : undefined);
                const sharedFrom = t.digestSbom?.shared ? (t.digestSbom.from ?? "another registry") : null;
                const isSha = /^[0-9a-f]{12,40}$/i.test(t.tag);
                return (
                  <tr key={t.id} className={trBorder}>
                    <td className={td}>
                      <span className="inline-flex items-center gap-2 font-mono text-sm text-gray-800 dark:text-white/90" title={t.tag}>{isSha ? t.tag.slice(0, 12) : t.tag}<button type="button" className="text-[11px] font-medium text-brand-500 hover:text-brand-600" onClick={() => copy(`${img.name}:${t.tag}`)}>{copied === `${img.name}:${t.tag}` ? "copied" : "copy"}</button></span>
                      {isSha && <span className={`block text-[11px] ${muted}`}>commit</span>}
                    </td>
                    <td className={`${td} font-mono text-xs ${muted}`} title={t.digest ?? ""}>{t.digest ? t.digest.slice(7, 19) : "—"}</td>
                    <td className={td}>{t.releaseVersion ? <Badge size="sm" color="success">{t.releaseVersion}</Badge> : <span className={`text-xs ${muted}`}>build</span>}</td>
                    <td className={td}>{(t.warnings ?? []).map((w) => <span key={w.code} className={`mb-1 block rounded-md px-2 py-0.5 text-[11px] ${w.code === "unaccepted_tag" ? "bg-error-50 text-error-600 dark:bg-error-500/15 dark:text-error-400" : "bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-warning-400"}`} title={w.message}>{w.code === "unaccepted_tag" ? "⚠ tag not accepted for its environment" : "⚠ rebuilt: same version, other digest"}</span>)}<EnvChips environments={t.environments ?? []} />{(t.alsoRunningIn ?? []).length > 0 && <span className={`mt-1 block text-[11px] ${muted}`} title={(t.alsoRunningIn ?? []).map((e) => `${e.name}: ${e.imageRef ?? ""}`).join("\n")}>same digest also runs in {(t.alsoRunningIn ?? []).map((e) => e.name).join(", ")} (other registry)</span>}</td>
                    <td className={`${td} ${muted}`} title={t.builtAt ? formatDate(t.builtAt) : "build time not read yet — first seen"}>{t.builtAt ? relativeTime(t.builtAt) : <span>{relativeTime(t.firstSeenAt ?? t.lastSeenAt)}<span className="block text-[11px]">first seen</span></span>}</td>
                    <td className={td}>{pending.images.has(`${img.name}:${t.tag}`) ? <span className="inline-flex items-center gap-2 text-sm text-brand-500"><Spinner />{b ? "Refreshing SBOM…" : "Generating SBOM…"}</span> : b ? <span className="flex flex-col gap-1">{sharedFrom && <span className={`text-[11px] ${muted}`} title={sharedFrom}>same digest · reused</span>}<Link to={`/projects/${projectId}/sboms/${b.id}`} className="text-sm text-brand-500 hover:underline">{b.componentCount} components</Link><FindingCounts counts={t.sbom?.findings} /></span> : <button type="button" className={linkButton} disabled={createJob.isPending} onClick={() => createJob.mutate({ serviceId: service.id, type: "sbom", payload: { target: "image", imageRef: `${img.name}:${t.tag}` } })}>Generate SBOM</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {img.tags.length > 5 && (
            <button type="button" className="w-full border-t border-gray-100 px-6 py-2.5 text-center text-sm font-medium text-brand-500 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-white/3" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show 5 most recent" : `Show all ${img.tags.length} tags`}</button>
          )}
          {createJob.error ? <div className="px-6 pb-3"><ErrorNotice error={createJob.error} /></div> : null}
        </div>
      )}
    </div>
  );
}

function Images({ service, projectId }: { service: Service; projectId: string }) {
  const inventory = useServiceInventory(service.id);
  const images = { data: inventory.data?.images, isLoading: inventory.isLoading };
  const registryInfo = useRegistryInfo();
  const add = useAddImage(service.id);
  const sync = useSyncImage(service.id);
  const remove = useRemoveImage(service.id);
  const integrations = useProjectIntegrations(projectId);
  const registries = (integrations.data ?? []).filter((i) => i.provider === "registry" && i.status !== "disconnected");
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState("");
  const [registry, setRegistry] = useState("");
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate({ name, integrationId: registry || undefined, insecure: name.startsWith("localhost") }, { onSuccess: () => { setDialog(false); setName(""); } }); };
  const builtInHost = registryInfo.data?.host ?? null;
  const list = [...(images.data ?? [])].sort((a, b) => (registryBrandForHost(a.name, builtInHost).brand === "platform" ? -1 : 0) - (registryBrandForHost(b.name, builtInHost).brand === "platform" ? -1 : 0) || a.name.localeCompare(b.name));
  return (
    <>
      <Toolbar actions={<button type="button" className={primaryButton} onClick={() => setDialog(true)}><PlusIcon className="size-4" /> Add image</button>}>
        Images that builds of {service.name} publish, grouped by registry. Registered when a deployment reports them, when they are pushed to the platform registry, or added here; tags and digests refresh every 15 minutes; tags link to releases by version or commit.
      </Toolbar>
      {(add.error || sync.error || remove.error) ? <div className="px-6 pb-3"><ErrorNotice error={add.error ?? sync.error ?? remove.error} /></div> : null}
      {list.length === 0 ? <EmptyState title="No image yet">Push to the built-in registry, connect yours, or let the deploy step report the image — see below. You can also add a name by hand.</EmptyState> : (
        <div className="space-y-4 px-6 pb-6">
          {list.map((img) => (
            <ImageCard key={img.id} img={img} projectId={projectId} service={service} builtInHost={builtInHost} syncing={sync.isPending && syncingId === img.id} onSync={() => { setSyncingId(img.id); sync.mutate(img.id); }} onRemove={() => { if (window.confirm(`Remove ${img.name} from the inventory?`)) remove.mutate(img.id); }} />
          ))}
        </div>
      )}
      {dialog && (
        <Modal isOpen title="Add a container image" onClose={() => setDialog(false)} className="max-w-150 p-6 lg:p-10">
          <form onSubmit={submit} className="space-y-5">
            <div><Label htmlFor="img-n">Image name (without tag)</Label><input id="img-n" required autoFocus className={inputClass} placeholder="ghcr.io/acme/payment-api" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><Label>Registry connection</Label><SelectField value={registry} onChange={setRegistry} options={[{ value: "", label: "Public image (no credentials)" }, ...registries.map((r) => ({ value: r.id, label: `${r.name}${r.inherited ? ` (${r.scope.type.toLowerCase()})` : ""}` }))]} /></div>
            {add.error ? <ErrorNotice error={add.error} /> : null}
            <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={() => setDialog(false)}>Cancel</button><button type="submit" className={primaryButton} disabled={add.isPending}>{add.isPending ? "Adding…" : "Add image"}</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function Deployments({ service, projectId }: { service: Service; projectId: string }) {
  const { project } = useProject();
  const data = useServiceDeployments(service.id);
  const inventory = useServiceInventory(service.id);
  const [manage, setManage] = useState<{ environmentId: string; section?: "details" | "deploy" | "kubernetes" | "ci" | "settings" } | null>(null);
  const env = (data.data?.environments ?? []).find((e) => e.id === manage?.environmentId);
  const joined = (id: string) => inventory.data?.environments.find((e) => e.id === id)?.current ?? null;
  return (
    <>
      <div className="px-6 py-3">
        <p className={`text-sm ${muted}`}>What runs in each environment of {service.name}. <em>Image</em> is the image currently deployed there (not the last build); <em>Since</em> is when that deployment was recorded. Use <em>Manage</em> for ids, deploying, Kubernetes, CI snippets and settings.</p>
      </div>
      {(data.data?.environments ?? []).length === 0 ? <EmptyState title="No environment yet">Declare environments on the Services page first.</EmptyState> : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Environment</th><th className={th}>Running</th><th className={th}>Image</th><th className={th}>Since</th><th className={th} /></tr></thead>
          <tbody>
            {(data.data?.environments ?? []).map((e) => {
              const c = joined(e.id);
              return (
                <tr key={e.id} className={trBorder}>
                  <td className={td}>
                    <span className="font-medium text-gray-800 dark:text-white/90">{e.name}</span> <Badge size="sm" color={ENV_COLOR[e.kind]}>{e.kind}</Badge>
                    <span className={`block text-xs ${muted}`}>{e.slug}{e.internetFacing ? " · internet-facing" : ""}{e.settings?.protected === true ? " · protected" : ""}{e.settings?.kubernetesNamespace ? ` · k8s ${e.settings.kubernetesNamespace}` : ""}</span>
                  </td>
                  <td className={td}>{c ? <><span className="font-medium text-gray-800 dark:text-white/90">{c.version ?? "build"}</span>{c.commitSha && <span className={`block font-mono text-xs ${muted}`}>{c.commitSha.slice(0, 12)}</span>}{!c.releaseId && c.imageTag && <span className={`block text-xs ${muted}`}>{c.imageTag.tag.slice(0, 12)}</span>}</> : <span className={`text-xs ${muted}`}>nothing recorded</span>}</td>
                  <td className={`${td} font-mono text-xs ${muted}`}>{c?.imageTag ? <>{(c.imageTag.image ?? "").split("/").slice(-1)[0]}:{c.imageTag.tag.slice(0, 12)}{c.imageTag.digest && <span className="block">{c.imageTag.digest.slice(0, 19)}…</span>}</> : c?.imageRef ? <span className="break-all">{c.imageRef.length > 60 ? "…" + c.imageRef.slice(-58) : c.imageRef}</span> : "—"}</td>
                  <td className={`${td} ${muted}`}>{c ? <>{relativeTime(c.deployedAt)}<span className="block text-xs">{SOURCE_LABEL[c.source] ?? c.source}{c.sbom ? " · SBOM ✓" : ""}</span></> : "—"}</td>
                  <td className={`${td} text-end`}><button type="button" className={outlineButton} onClick={() => setManage({ environmentId: e.id })}>Manage</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(data.data?.history ?? []).length > 0 && (
        <details className="group border-t border-gray-100 dark:border-gray-800">
          <summary className={`flex cursor-pointer items-center justify-between px-6 py-3 text-sm font-medium text-gray-700 select-none hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/3`}>
            <span>Deployment history <span className={`font-normal ${muted}`}>· {data.data?.history.length} records</span></span>
            <span className={`text-xs ${muted} group-open:hidden`}>show</span><span className={`hidden text-xs ${muted} group-open:inline`}>hide</span>
          </summary>
          <div className="px-6 pb-5">
            <pre className="max-h-96 overflow-auto rounded-lg bg-gray-950 p-4 font-mono text-xs leading-6 text-gray-200">
              {(data.data?.history ?? []).map((d: Deployment, i: number) => (
                <div key={d.id} className="flex gap-4 whitespace-pre">
                  <span className="w-8 shrink-0 text-end text-gray-600 select-none">{i + 1}</span>
                  <span className="text-gray-500">{formatDate(d.deployedAt)}</span>
                  <span className={d.supersededAt ? "text-gray-400" : "text-emerald-400"}>{d.supersededAt ? "superseded" : "current   "}</span>
                  <span className="text-sky-300">{d.environmentName}</span>
                  <span className="text-gray-100">{d.version ?? "build"}</span>
                  <span className="text-gray-500">{d.imageRef ? (d.imageRef.length > 70 ? "…" + d.imageRef.slice(-68) : d.imageRef) : ""}</span>
                  <span className="text-amber-300">{SOURCE_LABEL[d.source] ?? d.source}</span>
                </div>
              ))}
            </pre>
          </div>
        </details>
      )}
      {manage && env && <EnvironmentManager project={project} service={service} environment={env} current={env.current} projectId={projectId} initial={manage.section} onClose={() => setManage(null)} />}
    </>
  );
}

/** What runs where, joined: release, image digest, SBOM, since — per environment of the service. */
function EnvironmentOverview({ service, projectId }: { service: Service; projectId: string }) {
  const inventory = useServiceInventory(service.id);
  const envs = inventory.data?.environments ?? [];
  if (!envs.length) return null;
  return (
    <Card title="Running now" description="The release and image in each environment of this service, with the SBOM of what is running." flush>
      <table className="min-w-full">
        <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Environment</th><th className={th}>Release</th><th className={th}>Image</th><th className={th}>Since</th><th className={th}>SBOM</th></tr></thead>
        <tbody>
          {envs.map((e) => (
            <tr key={e.id} className={trBorder}>
              <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{e.name}</span> <Badge size="sm" color={ENV_COLOR[e.kind] ?? "light"}>{e.kind}</Badge>{e.internetFacing && <span className={`ms-2 text-xs ${muted}`}>internet-facing</span>}{e.settings?.protected === true && <Badge size="sm" color="light">protected</Badge>}</td>
              <td className={td}>{e.current ? <><span className="font-medium text-gray-800 dark:text-white/90">{e.current.version ?? "—"}</span>{e.current.commitSha && <span className={`block font-mono text-xs ${muted}`}>{e.current.commitSha.slice(0, 12)}</span>}{!e.current.releaseId && <span className={`block text-xs ${muted}`}>build, no release yet</span>}</> : <span className={`text-xs ${muted}`}>nothing recorded</span>}</td>
              <td className={`${td} font-mono text-xs ${muted}`}>{e.current?.imageTag ? <>{(e.current.imageTag.image ?? "").split("/").slice(-1)[0]}:{e.current.imageTag.tag}{e.current.imageTag.digest && <span className="block">{e.current.imageTag.digest.slice(0, 19)}…</span>}</> : e.current?.imageRef ? <span className="break-all">{e.current.imageRef.slice(-60)}</span> : "—"}</td>
              <td className={`${td} ${muted}`}>{e.current ? <>{relativeTime(e.current.deployedAt)}<span className="block text-xs">{SOURCE_LABEL[e.current.source] ?? e.current.source}</span></> : "—"}</td>
              <td className={td}>{e.current?.sbom ? <span className="flex flex-col gap-1"><Link to={`/projects/${projectId}/sboms/${e.current.sbom.id}`} className="text-sm text-brand-500 hover:underline">{e.current.sbom.componentCount} components</Link><FindingCounts counts={e.current.sbom.findings} /></span> : e.current ? <span className={`text-xs ${muted}`}>not yet generated</span> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function ProjectInventoryPage() {
  const { project, focusService: current, service: selected, services } = useProject();
  const [tabForCard, setTabForCard] = useState<"releases" | "images">("releases");
  const [tab, setTabState] = useState<"releases" | "images">("releases");
  const setTab = (t: "releases" | "images") => { setTabState(t); setTabForCard(t); };
  return (
    <div className="space-y-6">
    {current && <EnvironmentOverview service={current} projectId={project.id} />}
    <Card
      title="Inventory"
      description="What exists of this service: its releases (each with its commit, images and where it runs) and the container images built from them."
      flush
      actions={!selected && services.length > 1 && current ? <span className={`text-xs ${muted}`}>Showing {current.name} — pick a service in the navbar to change</span> : undefined}
    >
      {!current ? <EmptyState title="No service yet">Create a service first.</EmptyState> : (
        <>
          <Tabs value={tab} onChange={setTab} items={[{ value: "releases", label: "Releases" }, { value: "images", label: "Container images" }]} />
          {tab === "releases" && <Releases key={current.id} service={current} projectId={project.id} />}
          {tab === "images" && <Images key={current.id} service={current} projectId={project.id} />}
        </>
      )}
    </Card>
    {tabForCard === "images" && current && <RegistryCard project={project} service={current} />}
    </div>
  );
}
