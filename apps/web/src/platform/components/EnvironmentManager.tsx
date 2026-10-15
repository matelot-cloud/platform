import { CodeBlock } from "./CodeBlock";
import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useEnvironmentRegistry, useEnvironmentSettings, useEvaluateGate, useImages, useKubernetesSync, usePromoteImage, useRecordDeployment, useRegistryInfo, useReleases } from "@/platform/api/hooks";
import type { Deployment, Environment, ProjectRow, Service } from "@/platform/api/types";
import { formatDate } from "@/platform/format";
import { cn } from "@/utils";
import { ciSnippet, type CiSnippetInput, type CiSystem, CiTabs } from "./ci-snippets";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ENV_COLOR } from "./ServicePanel";
import { ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField } from "./ui";

export const BRAND_ICON = { matelot: "/logo.png", gar: "/images/brands/gar.png", bitbucket: "/images/brands/bitbucket.png", jira: "/images/brands/jira.png", slack: "/images/brands/slack.png", teams: "/images/brands/teams.png", email: "/images/brands/email.png", github: "/images/brands/github.png", gitlab: "/images/brands/gitlab.png", kubernetes: "/images/brands/kubernetes.png", docker: "/images/brands/docker.png", git: "/images/brands/git.png", ecr: "/images/brands/ecr.png", acr: "/images/brands/acr.png" } as const;

/** Registry brand from an image name / host: ECR, ACR, GHCR, GitLab, Docker Hub, built-in (platform mark) or generic. */
export function registryBrandForHost(imageOrHost: string, builtInHost?: string | null): { brand: keyof typeof BRAND_ICON | "platform"; label: string } {
  const host = imageOrHost.split("/")[0].toLowerCase();
  if (builtInHost && host === builtInHost.toLowerCase()) return { brand: "platform", label: "Matelot registry" };
  if (/\.dkr\.ecr\./.test(host)) return { brand: "ecr", label: "AWS ECR" };
  if (host.endsWith(".azurecr.io")) return { brand: "acr", label: "Azure Container Registry" };
  if (host.endsWith("-docker.pkg.dev") || host === "gcr.io" || host.endsWith(".gcr.io")) return { brand: "gar", label: host.endsWith("pkg.dev") ? "Google Artifact Registry" : "Google Container Registry" };
  if (host === "ghcr.io") return { brand: "github", label: "GitHub Container Registry" };
  if (host === "registry.gitlab.com" || host.startsWith("registry.")) return { brand: "gitlab", label: "GitLab registry" };
  if (host === "docker.io" || host === "registry-1.docker.io" || !host.includes(".") && !host.includes(":")) return { brand: "docker", label: "Docker Hub" };
  return { brand: "docker", label: host };
}

/** Brand for an integration provider. */
/**
 * Brand of a connection. Registries are recognised by cloud whatever the auth: stored secret (aws / gcp / azure),
 * keyless (aws_wif / gcp_wif / azure_wif), or a plain token / basic login to an ECR / ACR / GAR host.
 */
export function providerBrand(provider: string, authType?: string, host?: unknown): keyof typeof BRAND_ICON {
  if (provider === "registry") {
    const a = authType ?? "";
    if (a.startsWith("aws")) return "ecr";
    if (a.startsWith("gcp")) return "gar";
    if (a.startsWith("azure")) return "acr";
    const h = typeof host === "string" ? host.replace(/^https?:\/\//, "") : "";
    if (!h) return "docker";
    const b = registryBrandForHost(h).brand;
    return b === "platform" ? "matelot" : b;
  }
  return provider === "matelot" ? "matelot" : provider === "bitbucket" ? "bitbucket" : provider === "jira" ? "jira" : provider === "github" || provider === "github_token" ? "github" : provider === "gitlab" ? "gitlab" : "git";
}

export function BrandIcon({ name, className }: { name: keyof typeof BRAND_ICON | "platform"; className?: string }) {
  return <img src={name === "platform" ? "/logo.png" : BRAND_ICON[name]} alt="" aria-hidden="true" className={cn("size-5 shrink-0 select-none", className)} draggable={false} />;
}

type Section = "details" | "deploy" | "kubernetes" | "ci" | "settings";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <span className={`w-40 shrink-0 text-xs ${muted}`}>{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-md bg-gray-100 px-2 py-1 font-mono text-xs text-gray-800 dark:bg-white/5 dark:text-gray-200">{value}</code>
      <button type="button" className="shrink-0 text-xs font-medium text-brand-500 hover:text-brand-600" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** The windowed manager of one environment: details, deploy, Kubernetes, CI snippet, settings. */
export function EnvironmentManager({ project, service, environment, current, projectId, initial = "details", onClose }: { project: ProjectRow; service: Service; environment: Environment; current: Deployment | null; projectId: string; initial?: Section; onClose: () => void }) {
  const [section, setSection] = useState<Section>(initial);
  const [ci, setCi] = useState<CiSystem>("github");
  const registryInfo = useRegistryInfo();
  const envRegistry = useEnvironmentRegistry(environment.id);
  const images = useImages(service.id);
  const releases = useReleases(service.id);
  const promote = usePromoteImage(service.id);
  const gate = useEvaluateGate();
  const record = useRecordDeployment(service.id);
  const settings = useEnvironmentSettings(service.id);
  const k8s = useKubernetesSync(projectId, service.id);
  const buildPath = registryInfo.data?.available ? `${registryInfo.data.host}/${project.workspaceSlug}/${project.teamSlug}/${project.slug}/${service.slug}` : null;
  const buildTags = (images.data ?? []).filter((i) => registryInfo.data?.host && i.name.startsWith(`${registryInfo.data.host.toLowerCase()}/`)).flatMap((i) => i.tags.map((t) => t.tag));
  const [tag, setTag] = useState(buildTags[0] ?? "");
  const [version, setVersion] = useState("");
  const [imageRef, setImageRef] = useState("");
  const [namespace, setNamespace] = useState(environment.settings?.kubernetesNamespace ?? "");
  const [runnerTag, setRunnerTag] = useState(environment.settings?.runnerTag ?? "kubernetes");
  const [isProtected, setIsProtected] = useState(environment.settings?.protected === true);
  const envPath = envRegistry.data?.repository ? `${envRegistry.data.host}/${envRegistry.data.repository}` : null;

  const envVar = `MATELOT_ENV_${environment.slug.toUpperCase().replace(/-/g, "_")}`;
  const ciInput: CiSnippetInput = {
    intro: [`Build through the built-in registry, scan, then promote to "${environment.name}"${environment.settings?.protected ? ` (CI token must be allowed for "${environment.slug}")` : ""}.`],
    vars: { MATELOT_SERVICE_ID: service.id, [envVar]: environment.id }, docker: true, job: `deploy-${environment.slug}`, manual: environment.kind === "production",
    steps: [
      `matelot registry login`,
      `IMAGE=$(matelot registry path --service $MATELOT_SERVICE_ID)      # ${buildPath ?? "<build image path>"}\ndocker build -t $IMAGE:{sha} . && docker push $IMAGE:{sha}`,
      `matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait`,
      `matelot gate --env $${envVar} --image $IMAGE:{sha}${environment.kind === "production" ? "" : " || true"}   # ${environment.kind === "production" ? "blocking" : "warn-only unless the policy enforces"}`,
      `matelot promote --env $${envVar} --tag {sha}       # → ${envPath ?? "<environment path>"}`,
      `# Image kept elsewhere (Docker Hub, GHCR…)? Report it instead of promoting:\n# matelot deploy --env $${envVar} --version {ref} --image docker.io/acme/app@sha256:...`,
    ],
  };
  const ciText = ciSnippet(ci, ciInput);

  const nav: { key: Section; label: string; icon: ReactNode }[] = [
    { key: "details", label: "Details", icon: <span className="inline-block size-5 rounded-md bg-gray-200 text-center text-[11px] leading-5 font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200">ID</span> },
    { key: "deploy", label: "Deploy image", icon: <BrandIcon name="docker" /> },
    { key: "kubernetes", label: "Kubernetes", icon: <BrandIcon name="kubernetes" /> },
    { key: "ci", label: "CI snippet", icon: <span className="flex -space-x-1"><BrandIcon name="github" className="size-4" /><BrandIcon name="gitlab" className="size-4" /></span> },
    { key: "settings", label: "Settings", icon: <span className="inline-block size-5 rounded-md bg-gray-200 text-center text-[11px] leading-5 text-gray-700 dark:bg-white/10 dark:text-gray-200">⚙</span> },
  ];

  return (
    <Modal isOpen onClose={onClose} className="max-w-240 p-0" title={<>{environment.name} <Badge size="sm" color={ENV_COLOR[environment.kind] ?? "light"}>{environment.kind}</Badge></>} description={`Environment of ${service.name}`}>
      <div className="flex min-h-130 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-gray-100 md:w-56 md:border-r md:border-b-0 dark:border-gray-800">
          <nav className="flex gap-1 overflow-x-auto px-3 py-3 md:flex-col md:overflow-visible">
            {nav.map((n) => (
              <button key={n.key} type="button" onClick={() => setSection(n.key)} className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap", section === n.key ? "bg-brand-50 font-medium text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5")}>
                {n.icon}{n.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1 p-6">
          {section === "details" && (
            <div className="space-y-4">
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Identifiers and paths</h4>
              <p className={`text-sm ${muted}`}>Everything a pipeline needs for this environment. Values are copied as-is.</p>
              <div className="space-y-2">
                <CopyField label="Environment id" value={environment.id} />
                <CopyField label="Service id" value={service.id} />
                {buildPath && <CopyField label="Build image path" value={buildPath} />}
                {envPath && <CopyField label="Environment image path" value={envPath} />}
                {envPath && <CopyField label="Pull command" value={`docker pull ${envPath}:<tag>`} />}
              </div>
              <div className="rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-800">
                <p className="font-medium text-gray-800 dark:text-white/90">Running now</p>
                {current ? (
                  <ul className={`mt-1 space-y-0.5 ${muted}`}>
                    <li>Version: <span className="text-gray-800 dark:text-white/90">{current.version ?? "build without release"}</span></li>
                    {current.imageRef && <li className="break-all">Image: <span className="font-mono text-xs text-gray-800 dark:text-white/90">{current.imageRef}</span></li>}
                    <li>Since {formatDate(current.deployedAt)} · recorded by {current.source}</li>
                  </ul>
                ) : <p className={`mt-1 ${muted}`}>Nothing recorded yet.</p>}
              </div>
            </div>
          )}

          {section === "deploy" && (
            <div className="space-y-6">
              <div>
                <h4 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-white/90"><BrandIcon name="docker" /> Promote a build image</h4>
                <p className={`mt-1 text-sm ${muted}`}>Copies <code>{buildPath ?? "<build path>"}:&lt;tag&gt;</code> into <code>{envPath ?? "<environment path>"}:&lt;tag&gt;</code> inside the platform registry (no re-upload) and records the deployment. Your cluster pulls from the environment path.{environment.settings?.protected === true && <> This environment is <strong>protected</strong>.</>}</p>
                <form onSubmit={(e) => { e.preventDefault(); promote.mutate({ environmentId: environment.id, tag }); }} className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="min-w-64 flex-1">
                    <Label>Build tag</Label>
                    {buildTags.length ? <SelectField value={tag} onChange={setTag} options={buildTags.map((t) => ({ value: t, label: t }))} /> : <p className={`text-sm ${muted}`}>No build in the platform registry yet — push one to <code>{buildPath ?? "the build path"}</code>.</p>}
                  </div>
                  <button type="button" className={outlineButton} disabled={gate.isPending || !tag || !buildPath} onClick={() => gate.mutate({ environmentId: environment.id, imageRef: `${buildPath}:${tag}` })}>{gate.isPending ? "Checking…" : "Check gate"}</button>
                  <button type="submit" className={primaryButton} disabled={promote.isPending || !tag}>{promote.isPending ? "Promoting…" : "Promote"}</button>
                </form>
                {gate.data && <div className={`mt-2 rounded-lg border px-3 py-2 text-sm ${gate.data.result === "fail" ? "border-error-200 bg-error-50 dark:border-error-500/30 dark:bg-error-500/10" : gate.data.result === "warn" ? "border-warning-200 bg-warning-50 dark:border-warning-500/30 dark:bg-warning-500/10" : "border-success-200 bg-success-50 dark:border-success-500/30 dark:bg-success-500/10"}`}><span className="font-medium text-gray-800 dark:text-white/90">Gate {gate.data.result}</span>{gate.data.violations.length > 0 && <ul className={`mt-1 text-xs ${muted}`}>{gate.data.violations.map((v, i) => <li key={i}>{v.action === "block" ? "✗" : "!"} {v.policyName}: {v.message}</li>)}</ul>}{gate.data.result === "pass" && <span className={`ms-2 text-xs ${muted}`}>no policy violated — safe to promote</span>}</div>}
                {gate.error ? <div className="mt-2"><ErrorNotice error={gate.error} /></div> : null}
                {promote.isSuccess && <p className="mt-2 text-sm text-success-600">Promoted to {promote.data.to}.</p>}
                {promote.error ? <div className="mt-2"><ErrorNotice error={promote.error} /></div> : null}
              </div>
              <div className="border-t border-gray-100 pt-6 dark:border-gray-800">
                <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Record a deployment</h4>
                <p className={`mt-1 text-sm ${muted}`}>For images kept elsewhere (Docker Hub, GHCR…) or deployments done outside CI: name the version and/or the image that now runs here.</p>
                <form onSubmit={(e) => { e.preventDefault(); record.mutate({ environmentId: environment.id, version: version || undefined, imageRef: imageRef || undefined }, { onSuccess: () => { setVersion(""); setImageRef(""); } }); }} className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div><Label>Version</Label><SelectField value={version} onChange={setVersion} options={[{ value: "", label: "— none / build only —" }, ...(releases.data ?? []).map((r) => ({ value: r.version, label: r.version }))]} /></div>
                  <div><Label>Image (name:tag or name@digest)</Label><input className={inputClass} placeholder="docker.io/acme/app@sha256:…" value={imageRef} onChange={(e) => setImageRef(e.target.value)} /></div>
                  <div className="md:col-span-2"><button type="submit" className={outlineButton} disabled={record.isPending || (!version && !imageRef)}>{record.isPending ? "Recording…" : "Record deployment"}</button></div>
                </form>
                {record.isSuccess && <p className="mt-2 text-sm text-success-600">Recorded.</p>}
                {record.error ? <div className="mt-2"><ErrorNotice error={record.error} /></div> : null}
              </div>
            </div>
          )}

          {section === "kubernetes" && (
            <div className="space-y-4">
              <h4 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-white/90"><BrandIcon name="kubernetes" /> Kubernetes</h4>
              <p className={`text-sm ${muted}`}>A platform runner with access to the cluster reads the workloads of the namespace; images of {service.name} found there become the deployment of this environment (by digest). No CI change needed.</p>
              <form onSubmit={(e) => { e.preventDefault(); settings.mutate({ environmentId: environment.id, kubernetesNamespace: namespace || undefined, runnerTag: runnerTag || undefined }); }} className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div><Label htmlFor="ns">Namespace</Label><input id="ns" className={inputClass} placeholder="payments-prod" value={namespace} onChange={(e) => setNamespace(e.target.value)} /></div>
                <div><Label htmlFor="rt">Runner tag</Label><input id="rt" className={inputClass} placeholder="kubernetes" value={runnerTag} onChange={(e) => setRunnerTag(e.target.value)} /><p className={`mt-1 text-xs ${muted}`}>Only runners carrying this tag are used (they must reach the cluster).</p></div>
                <div className="flex gap-2 md:col-span-2">
                  <button type="submit" className={outlineButton} disabled={settings.isPending}>{settings.isPending ? "Saving…" : "Save"}</button>
                  <button type="button" className={primaryButton} disabled={!environment.settings?.kubernetesNamespace || k8s.isPending} onClick={() => k8s.mutate(environment.id)}>{k8s.isPending ? "Queuing…" : "Sync from Kubernetes now"}</button>
                </div>
              </form>
              {settings.isSuccess && <p className="text-sm text-success-600">Saved.</p>}
              {k8s.isSuccess && <p className="text-sm text-success-600">Sync job queued — see <Link to={`/projects/${projectId}/jobs`} className="text-brand-500 hover:underline">Jobs</Link>.</p>}
              {(settings.error || k8s.error) ? <ErrorNotice error={settings.error ?? k8s.error} /> : null}
              <div className={`rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-800 ${muted}`}>
                Runner in the cluster: <code>helm install secops-runner …</code> or the Kubernetes tab under <Link to={`/projects/${projectId}/runners`} className="text-brand-500 hover:underline">Runners → Register runner</Link>. Tag it <code>{runnerTag || "kubernetes"}</code>.
              </div>
            </div>
          )}

          {section === "ci" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">CI snippet for {environment.name}</h4>
                <CiTabs value={ci} onChange={setCi} />
              </div>
              <p className={`text-sm ${muted}`}>Uses the <code>matelot</code> CLI (installed from GitHub in the snippet); nothing is hard-coded — hosts and paths are resolved from the platform. Requests are HMAC-signed; the secret never leaves the runner.</p>
              <CodeBlock code={ciText} />
              <div className="flex justify-end"><button type="button" className={outlineButton} onClick={() => void navigator.clipboard?.writeText(ciText)}>Copy snippet</button></div>
            </div>
          )}

          {section === "settings" && (
            <div className="space-y-4">
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Settings</h4>
              <form onSubmit={(e) => { e.preventDefault(); settings.mutate({ environmentId: environment.id, protected: isProtected }); }} className="space-y-4">
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-1" checked={isProtected} onChange={(e) => setIsProtected(e.target.checked)} />
                  <span><span className="font-medium text-gray-800 dark:text-white/90">Protected environment</span><span className={`block text-xs ${muted}`}>Only CI tokens explicitly allowed for "{environment.slug}" (Settings → CI tokens → May deploy to) can push or promote images into it or record deployments; people need the deploy permission here. Recommended for production.</span></span>
                </label>
                <div className={`text-sm ${muted}`}>Kind: <span className="text-gray-800 dark:text-white/90">{environment.kind}</span> · Internet-facing: <span className="text-gray-800 dark:text-white/90">{environment.internetFacing ? "yes" : "no"}</span> — change these on the Services page.</div>
                <button type="submit" className={primaryButton} disabled={settings.isPending}>{settings.isPending ? "Saving…" : "Save settings"}</button>
                {settings.isSuccess && <p className="text-sm text-success-600">Saved.</p>}
                {settings.error ? <ErrorNotice error={settings.error} /> : null}
              </form>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
