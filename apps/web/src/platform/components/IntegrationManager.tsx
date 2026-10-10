import { CodeBlock } from "./CodeBlock";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useCreateEcrRepository, useDeleteIntegration, useDisconnectIntegration, useEcrRepositories, useIntegrationInstallUrl, useLinkInstallation, useMatelotRepositories, useOrganizationRepositories, useSyncIntegration, useVerifyIntegration } from "@/platform/api/hooks";
import type { Integration } from "@/platform/api/types";
import { ApiError } from "@/platform/api/client";
import { formatDate, relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useState, type ReactNode } from "react";
import { BrandIcon, providerBrand } from "./EnvironmentManager";
import { describe } from "./IntegrationsPanel";
import { dangerButton, ErrorNotice, inputClass, muted, outlineButton, primaryButton } from "./ui";
import { cloudKindOf, isKeylessAuth, KeylessIdentity } from "./KeylessIdentity";
import { ciSnippet, type CiSnippetInput, type CiSystem, CiTabs } from "./ci-snippets";

type Section = "details" | "howto" | "repositories" | "identity" | "actions";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <span className={`w-36 shrink-0 text-xs ${muted}`}>{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-md bg-gray-100 px-2 py-1 font-mono text-xs text-gray-800 dark:bg-white/5 dark:text-gray-200">{value}</code>
      <button type="button" className="shrink-0 text-xs font-medium text-brand-500 hover:text-brand-600" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** The windowed manager of one connection: details, repositories it provides, actions. */
export function IntegrationManager({ integration: i, organizationId, repoCount, onClose }: { integration: Integration; organizationId: string; repoCount: number; onClose: () => void }) {
  const [section, setSection] = useState<Section>(isKeylessAuth(i.authType) && !i.settings?.verified && i.status !== "disconnected" ? "identity" : "details");
  const installUrl = useIntegrationInstallUrl();
  const sync = useSyncIntegration(organizationId);
  const disconnect = useDisconnectIntegration(organizationId);
  const verify = useVerifyIntegration(organizationId);
  const remove = useDeleteIntegration(organizationId);
  const repositories = useOrganizationRepositories(organizationId);
  const repos = (repositories.data ?? []).filter((r) => r.integrationId === i.id);
  const isEcr = i.provider === "registry" && (i.authType === "aws" || i.authType === "aws_wif");
  const isKeyless = isKeylessAuth(i.authType);
  const cloudKind = cloudKindOf(i.provider, i.authType);
  const ecr = useEcrRepositories(i.id, isEcr && section === "repositories");
  const isMatelot = i.provider === "matelot";
  const mrepos = useMatelotRepositories(i.id, isMatelot);
  const createEcr = useCreateEcrRepository(i.id);
  const [ecrName, setEcrName] = useState("");
  const [ecrScan, setEcrScan] = useState(true);
  const [ecrImmutable, setEcrImmutable] = useState(false);
  const install = () => installUrl.mutate(i.id, { onSuccess: ({ url }) => window.location.assign(url) });
  const link = useLinkInstallation(organizationId);
  const ownApp = i.provider === "github" && i.authType === "app";
  const granted = (i.settings?.permissions ?? null) as Record<string, string> | null;
  const REQUIRED: { key: string; level: string; why: string }[] = [{ key: "metadata", level: "read", why: "list repositories" }, { key: "contents", level: "read", why: "clone and scan" }, { key: "administration", level: "read", why: "repository settings" }, { key: "issues", level: "write", why: "remediation issues" }, { key: "organization_projects", level: "write", why: "add issues to Projects boards" }];
  const rank = (v?: string) => (v === "admin" ? 3 : v === "write" ? 2 : v === "read" ? 1 : 0);
  const missing = granted ? REQUIRED.filter((r) => rank(granted[r.key]) < rank(r.level)) : [];
  const capabilities = i.provider === "matelot" ? ["build repositories per service, scanned on every push", "environment repositories written by promote (protected environments enforced)", "CI login with CI tokens; people with personal tokens"] : i.provider === "github" && i.authType === "app" ? ["clone & scan", "webhooks", "issues", "boards: organization-owned Projects only"] : i.provider === "github_token" ? ["clone & scan (polling)", "issues", "boards: user- or organization-owned Projects"] : i.provider === "git" ? ["clone & scan (polling)", "no issues, no boards (deploy key / plain git)"] : i.provider === "gitlab" ? ["clone & scan (polling)", "issues (token scope api)", "boards via labels"] : i.provider === "bitbucket" ? ["clone & scan (polling)", "issues (repo tracker enabled)", "no boards"] : i.provider === "jira" ? ["issues in a Jira project"] : ["image pull & scan", "CI registry login"];
  const brand = providerBrand(i.provider, i.authType, i.settings?.baseUrl);
  const webhook = i.provider === "github" && i.settings?.ownApp ? `${window.location.origin}/api/v1/webhooks/github/${i.id}` : null;
  const publicKey = i.authType === "ssh" && i.settings?.publicKey ? String(i.settings.publicKey) : null;
  const err = sync.error ?? disconnect.error ?? verify.error ?? (remove.error instanceof ApiError && remove.error.status === 409 ? null : remove.error) ?? installUrl.error ?? link.error;

  const host = String(i.settings?.baseUrl ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const isAcr = i.provider === "registry" && (i.authType === "azure" || i.authType === "azure_wif");
  const [ci, setCi] = useState<CiSystem>("github");
  const howto: { title: string; needs: string[]; input: CiSnippetInput; note?: string } = (() => {
    const svc = { MATELOT_SERVICE_ID: "<service id>", MATELOT_ENV_DEV: "<environment id>" };
    if (i.provider === "registry") {
      const isGar = i.authType === "gcp" || i.authType === "gcp_wif";
      const kind = isEcr ? "ECR" : isAcr ? "ACR" : isGar ? "Artifact Registry" : host.includes("docker.io") ? "Docker Hub" : host === "ghcr.io" ? "GHCR" : "registry";
      return {
        title: `Push, pull and scan images on ${kind} from CI`,
        needs: isEcr
          ? ["IAM key with ecr:GetAuthorizationToken, BatchGetImage, GetDownloadUrlForLayer, ListImages, DescribeImages, DescribeRepositories", "+ CreateRepository for `--create`, + PutImage/InitiateLayerUpload/UploadLayerPart/CompleteLayerUpload when CI pushes", "a CI token with registry:pull: presets pipeline / full"]
          : isGar
            ? ["service account with roles/artifactregistry.reader (roles/artifactregistry.writer when CI pushes through the platform)", "a CI token with registry:pull: presets pipeline / full", "repositories: create the Artifact Registry repository once (gcloud artifacts repositories create) — images go to <host>/<project>/<repo>/<image>"]
          : isAcr
            ? ["service principal with AcrPull (AcrPush when CI pushes)", "a CI token with registry:pull: presets pipeline / full", "repositories are created on first push — no `--create` needed"]
            : ["a robot / read token on the registry (read & write when CI pushes through the platform)", "a CI token with registry:pull: presets pipeline / full"],
        input: {
          intro: [`Build, push, scan and deploy through the "${i.name}" connection — no cloud credentials on the runner`],
          vars: svc, docker: true, job: "build",
          steps: [
            `matelot registry login --connection "${i.name}" --service $MATELOT_SERVICE_ID`,
            `IMAGE=$(matelot registry path --service $MATELOT_SERVICE_ID --connection "${i.name}" --repository my-service${isEcr ? " --create" : ""})\ndocker build -t $IMAGE:{sha} . && docker push $IMAGE:{sha}\nDIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' $IMAGE:{sha} | cut -d@ -f2)`,
            `matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait`,
            `matelot deploy --env $MATELOT_ENV_DEV --version {shortSha} --image $IMAGE@$DIGEST`,
          ],
        },
        note: `The platform exchanges the stored credential for short-lived Docker credentials (${isEcr ? "12-hour ECR tokens" : isAcr ? "~3-hour ACR tokens" : isGar ? "1-hour Google access tokens" : "the registry token"}); the CI token never sees the cloud credential.`,
      };
    }
    if (i.provider === "github") return {
      title: "Repositories via the GitHub App",
      needs: ["App installed on the organization with the repositories selected (Actions → Install on GitHub)", "webhooks arrive automatically: pushes start the security pipeline (project Settings → Automation), tags become releases"],
      input: {
        intro: ["Attach a repository to a service: project → Services → the service → Attach repository.", "Every push to the default branch then runs the security pipeline by itself; CI only reports deployments (or drives the scan explicitly)."],
        vars: svc, job: "deploy",
        steps: [`matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait   # optional: CI-driven scan`, `matelot deploy --env $MATELOT_ENV_DEV --version {ref} --image ghcr.io/acme/app@sha256:...`],
      },
      note: "No personal tokens anywhere. Own App: put the webhook URL from Details into the App's settings, secret = the one you registered. Issues from Remediation open in the service repository.",
    };
    if (i.provider === "github_token" || i.provider === "gitlab" || i.provider === "bitbucket") return {
      title: i.provider === "gitlab" ? "Repositories via a GitLab group/project token" : i.provider === "bitbucket" ? "Repositories of a Bitbucket workspace" : "Repositories via a GitHub token",
      needs: [i.provider === "gitlab" ? "group or project access token with read_api (read_repository for cloning, api for issues)" : i.provider === "bitbucket" ? "app password with repository read, pull requests read, issues write (or a workspace access token)" : "fine-grained token with Contents: read on the repositories (Metadata: read; Issues: write for remediation issues)", "no webhooks: the platform polls tags; start pipelines from CI as below"],
      input: {
        intro: ["Scan every build and report deployments (webhooks are not available for token connections)."],
        vars: svc, job: "security",
        steps: [`matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait`, `matelot deploy --env $MATELOT_ENV_DEV --version {ref} --image <image>@sha256:...`],
      },
      note: `Releases: git tags${i.provider === "gitlab" ? " / GitLab releases" : ""} are synced. Remediation issues open in the service repository on ${i.provider === "gitlab" ? "GitLab" : i.provider === "bitbucket" ? "Bitbucket (issue tracker must be enabled)" : "GitHub"}.`,
    };
    if (i.provider === "matelot") {
      const ns = String(i.settings?.namespace ?? "<namespace>");
      const host = String(i.settings?.baseUrl ?? "<registry host>");
      return {
        title: "Build, push, scan and promote with the Matelot registry",
        needs: ["a CI token for this project (project Settings → CI tokens, preset pipeline or full) — no registry password", `images live under ${host}/${ns}/…/<service> (builds) and …/<service>/<environment> (deployed)`, "protected environments only accept promotions from CI tokens allowed on them"],
        input: {
          intro: [`Matelot registry ${host}/${ns}: the CI token is exchanged for a short-lived registry login`],
          vars: { MATELOT_SERVICE_ID: "<service id>", MATELOT_ENV_DEV: "<environment id>" }, docker: true, job: "build",
          steps: [
            "matelot registry login",
            "IMAGE=$(matelot registry path --service $MATELOT_SERVICE_ID)\ndocker build -t $IMAGE:{sha} . && docker push $IMAGE:{sha}",
            "matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait",
            "matelot gate --env $MATELOT_ENV_DEV --image $IMAGE:{sha} || true",
            "matelot promote --env $MATELOT_ENV_DEV --tag {sha}",
          ],
        },
        note: "Kubernetes pulls: create a CI token with the pull preset for the environment and use its key id / secret as registry username / password: kubectl create secret docker-registry matelot-pull --docker-server=<host> --docker-username=<keyId> --docker-password=<secret>.",
      };
    }
    if (i.provider === "jira") return {
      title: "Jira Cloud issues from Remediation",
      needs: ["Atlassian e-mail + API token with access to the project", "the Jira project key, set under Remediation → SLAs & issues at the organization, workspace, team or project that should use it"],
      input: { intro: ["Nothing to add to CI: issues are created from the fix-first queue (UI, CLI or Claude via MCP)."], vars: {}, secrets: ["MATELOT_TOKEN"], job: "triage", steps: [`matelot remediation issue --id <remediationId> --provider jira --project-key SEC`] },
      note: "The nearest Jira connection on the project's chain (project → team → workspace → organization) is used.",
    };
    return {
      title: "One repository over git",
      needs: [i.authType === "ssh" ? "the public deploy key from Details added to the repository (read-only), then Actions → Test connection" : "HTTPS credentials with read access", "attach the repository to a service; runners clone with these credentials"],
      input: { intro: ["Scan every build and report deployments."], vars: svc, job: "security", steps: [`matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait`, `matelot deploy --env $MATELOT_ENV_DEV --version {ref} --image <image>@sha256:...`] },
      note: "Issues cannot be opened on a plain git host: set Jira under Remediation → SLAs & issues, or reconnect the repository through GitHub / GitLab / Bitbucket.",
    };
  })();
  const snippet = ciSnippet(ci, howto.input);

  const nav: { key: Section; label: string; icon: ReactNode }[] = [
    { key: "details", label: "Details", icon: <span className="inline-block size-5 rounded-md bg-gray-200 text-center text-[11px] leading-5 font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200">ID</span> },
    { key: "howto", label: "How to use", icon: <span className="inline-block size-5 rounded-md bg-gray-200 text-center text-[11px] leading-5 font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200">?</span> },
    { key: "repositories", label: isEcr ? "ECR repositories" : isMatelot ? `Image repositories (${mrepos.data?.repositories.length ?? 0})` : `Repositories (${repoCount})`, icon: <BrandIcon name={brand} /> },
    ...(cloudKind ? [{ key: "identity" as Section, label: isKeyless ? "Identity · keyless" : "Identity · go keyless", icon: <span className="inline-block size-5 rounded-md bg-gray-200 text-center text-[11px] leading-5 font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200">ID</span> }] : []),
    { key: "actions", label: "Actions", icon: <span className="inline-block size-5 rounded-md bg-gray-200 text-center text-[11px] leading-5 text-gray-700 dark:bg-white/10 dark:text-gray-200">⚙</span> },
  ];

  return (
    <Modal isOpen onClose={onClose} className="max-w-240 p-0">
      <div className="flex min-h-120 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-gray-100 md:w-60 md:border-r md:border-b-0 dark:border-gray-800">
          <div className="px-5 pt-5 pb-3">
            <div className="flex items-center gap-3">
              <BrandIcon name={brand} className="size-9" />
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-gray-800 dark:text-white/90">{i.name}</p>
                <p className={`truncate text-xs ${muted}`}>{describe(i)}</p>
              </div>
            </div>
            <p className="mt-2"><Badge size="sm" color={i.status === "connected" ? "success" : i.status === "error" ? "error" : i.status === "pending" ? "warning" : "light"}>{i.status}</Badge>{i.inherited && <Badge size="sm" color="light">inherited</Badge>}</p>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
            {nav.map((n) => (
              <button key={n.key} type="button" onClick={() => setSection(n.key)} className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap", section === n.key ? "bg-brand-50 font-medium text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5")}>{n.icon}{n.label}</button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1 p-6 pe-20 sm:pe-24">
          {section === "details" && (
            <div className="space-y-4">
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Details</h4>
              <div className="space-y-2">
                <CopyField label="Connection id" value={i.id} />
                <CopyField label="Level" value={`${i.scope.type.toLowerCase()} · ${i.scope.name}`} />
                {i.externalAccountId && <CopyField label="External account" value={i.externalAccountId} />}
                {webhook && <CopyField label="Webhook URL (GitHub servers POST here)" value={webhook} />}
                {ownApp && <CopyField label="Setup URL / Redirect URI (the browser is sent here)" value={`${window.location.origin}/api/v1/integrations/github/callback`} />}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-white/90">What this connection can do</p>
                <ul className={`mt-1 list-disc ps-5 text-sm ${muted}`}>{capabilities.map((c) => <li key={c}>{c}</li>)}</ul>
              </div>
              {i.status === "pending" && <div className="rounded-xl border border-warning-500/30 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:bg-warning-500/10 dark:text-warning-400">Pending: {String(i.settings?.pendingReason ?? (i.externalAccountId ? "first repository sync has not completed" : ownApp ? "waiting for the GitHub installation callback" : "not verified yet"))}. {ownApp && !i.externalAccountId && "If the App is already installed on the organization, GitHub opens the installation settings instead of coming back — use \"Link existing installation\" under Actions."}</div>}
              {ownApp && granted && (missing.length ? <div className="rounded-xl border border-warning-500/30 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:bg-warning-500/10 dark:text-warning-400"><p className="font-medium">Missing permissions on the installation</p><ul className="mt-1 list-disc ps-5 text-xs">{missing.map((m) => <li key={m.key}>{m.key} ({m.level}) — {m.why}</li>)}</ul><p className="mt-1 text-xs">Add them in the App settings, accept the request on GitHub (Organization → Settings → GitHub Apps → this App), then "Check again" under Actions.</p></div> : <p className={`text-xs ${muted}`}>Installation permissions verified: {Object.entries(granted).map(([k, v]) => `${k}:${v}`).join(", ")}</p>)}
              <div className="space-y-2">
                <CopyField label="Last sync" value={i.lastSyncedAt ? formatDate(i.lastSyncedAt) : "never"} />
              </div>
              {publicKey && (
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-white/90">Deploy key (public half){i.settings?.verified ? <Badge size="sm" color="success">verified</Badge> : <Badge size="sm" color="warning">not verified</Badge>}</p>
                  <p className={`mt-1 text-xs ${muted}`}>Add it to the repository's deploy keys (read-only), then run <em>Test connection</em> under Actions.</p>
                  <CodeBlock code={publicKey} className="mt-2" wrap lines={false} />
                  <button type="button" className={`${outlineButton} mt-2`} onClick={() => void navigator.clipboard?.writeText(publicKey)}>Copy public key</button>
                </div>
              )}
              {i.lastError && <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-600 dark:border-error-500/30 dark:bg-error-500/10">{i.lastError}</div>}
            </div>
          )}

          {section === "howto" && (
            <div className="space-y-4">
              <h4 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-white/90"><BrandIcon name={brand} /> {howto.title}</h4>
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-white/90">What is needed</p>
                <ul className={`mt-1 list-disc space-y-0.5 ps-5 text-sm ${muted}`}>{howto.needs.map((n) => <li key={n}>{n}</li>)}</ul>
              </div>
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium text-gray-800 dark:text-white/90">In CI, with the <code>matelot</code> CLI</p>
                  <CiTabs value={ci} onChange={setCi} />
                </div>
                <p className={`mt-1 text-xs ${muted}`}>Ids: project → Services → the service (service id), Environments (environment ids). CI tokens: project Settings → CI tokens or <code>matelot ci-token create</code>.</p>
                <CodeBlock code={snippet} className="mt-2" />
              </div>
              {howto.note && <p className={`text-sm ${muted}`}>{howto.note}</p>}
            </div>
          )}

          {section === "repositories" && (
            <div className="space-y-3">
              <h4 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-white/90"><BrandIcon name={brand} /> {isMatelot ? "Image repositories under this namespace" : "Repositories from this connection"}</h4>
              {isMatelot ? (
                <div className="space-y-2">
                  <p className={`text-sm ${muted}`}>One repository per service (builds, scanned on push) and one per environment (<code>…/&lt;environment&gt;</code>, written by <code>matelot promote</code>). They exist as soon as the first image is pushed.</p>
                  {(mrepos.data?.repositories ?? []).length === 0 ? <p className={`text-sm ${muted}`}>No services under this level yet.</p> : (
                    <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                      {mrepos.data!.repositories.map((r) => <li key={r.serviceId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"><span className="text-sm text-gray-800 dark:text-white/90">{r.project} / {r.service}</span><code className="text-xs text-gray-600 dark:text-gray-400">{mrepos.data!.host}/{r.repository}</code></li>)}
                    </ul>
                  )}
                </div>
              ) : isEcr ? (
                <div className="space-y-4">
                  <p className={`text-sm ${muted}`}>Repositories in this AWS account and region, read with the connection's key. Create the one your CI pushes to here — ECR needs it to exist before the first push. Names: <code>app</code> or <code>team/app</code>.</p>
                  <form onSubmit={(e) => { e.preventDefault(); createEcr.mutate({ name: ecrName.trim(), scanOnPush: ecrScan, immutableTags: ecrImmutable }, { onSuccess: () => setEcrName("") }); }} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
                    <div className="min-w-60 flex-1"><label className={`mb-1 block text-xs ${muted}`} htmlFor="ecr-name">New repository</label><input id="ecr-name" required className={inputClass} placeholder="team/app" value={ecrName} onChange={(e) => setEcrName(e.target.value)} /></div>
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><input type="checkbox" checked={ecrScan} onChange={(e) => setEcrScan(e.target.checked)} />scan on push</label>
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><input type="checkbox" checked={ecrImmutable} onChange={(e) => setEcrImmutable(e.target.checked)} />immutable tags</label>
                    <button type="submit" className={primaryButton} disabled={createEcr.isPending || !ecrName.trim()}>{createEcr.isPending ? "Creating…" : "Create repository"}</button>
                  </form>
                  {createEcr.isSuccess && <p className="text-sm text-success-600">Created <code>{createEcr.data.repositoryUri}</code></p>}
                  {createEcr.error ? <ErrorNotice error={createEcr.error} /> : null}
                  {ecr.error ? <ErrorNotice error={ecr.error} /> : ecr.isLoading ? <p className={`text-sm ${muted}`}>Reading repositories from AWS…</p> : (ecr.data ?? []).length === 0 ? <p className={`text-sm ${muted}`}>No repository in this account/region yet.</p> : (
                    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                      {(ecr.data ?? []).map((r) => (
                        <li key={r.repositoryName} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                          <span className="min-w-0"><span className="block truncate font-medium text-gray-800 dark:text-white/90">{r.repositoryName}</span><span className={`block truncate font-mono text-xs ${muted}`}>{r.repositoryUri}</span></span>
                          <span className="flex shrink-0 items-center gap-2">{r.scanOnPush && <Badge size="sm" color="light">scan on push</Badge>}{r.imageTagMutability === "IMMUTABLE" && <Badge size="sm" color="light">immutable</Badge>}<button type="button" className="text-xs font-medium text-brand-500 hover:text-brand-600" onClick={() => void navigator.clipboard?.writeText(r.repositoryUri)}>Copy URI</button></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : i.provider === "registry" ? <p className={`text-sm ${muted}`}>A registry connection provides image tags and digests, not repositories. Images using it are listed under each service's Container images.</p> : repos.length === 0 ? <p className={`text-sm ${muted}`}>None synced yet — run <em>Sync now</em> under Actions{i.provider === "github" && !i.externalAccountId ? ", after installing the App" : ""}.</p> : (
                <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                  {repos.slice(0, 50).map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                      <span className="min-w-0"><span className="truncate font-medium text-gray-800 dark:text-white/90">{r.fullName}</span><span className={`block text-xs ${muted}`}>{r.defaultBranch ?? "—"}{r.visibility === "private" ? " · private" : ""}{r.languages ? ` · ${Object.keys(r.languages).slice(0, 2).join(", ")}` : ""}</span></span>
                      <span className={`shrink-0 text-xs ${muted}`}>{r.services.length ? `${r.services.length} service${r.services.length > 1 ? "s" : ""}` : "not attached"}</span>
                    </li>
                  ))}
                  {repos.length > 50 && <li className={`px-4 py-2 text-xs ${muted}`}>… and {repos.length - 50} more on the Repositories page.</li>}
                </ul>
              )}
            </div>
          )}

          {section === "identity" && cloudKind && (
            <div className="space-y-4">
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Workload identity federation</h4>
              <p className="text-sm text-gray-500 dark:text-gray-400">{isKeyless ? "This connection stores no cloud secret: on every use the cell signs a 10-minute OpenID token for this connection and the cloud exchanges it for registry access." : "This connection stores a key. To go keyless, connect the same registry again with Keyless on: the new connection gets its own subject and shows its exact trust here. Verify it, then delete this one. The values below are this connection's, for reference."}</p>
              <KeylessIdentity integrationId={i.id} organizationId={organizationId} cloudKind={cloudKind} keyless={isKeyless} />
            </div>
          )}
          {section === "actions" && (
            <div className="space-y-5">
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Actions</h4>
              <div className="space-y-3">
                {i.provider === "github" && !i.externalAccountId && <Row title="Install on GitHub" text="Choose the organization and repositories the App may read.">
                  <button type="button" className={primaryButton} onClick={install} disabled={installUrl.isPending}>Install on GitHub</button></Row>}
                {ownApp && <Row title={i.externalAccountId ? "Check again" : "Link existing installation"} text={i.externalAccountId ? "Re-read the installation's granted permissions from GitHub (after accepting new permissions)." : "The App is already installed on GitHub: bind that installation without going through the install page."}>
                  <button type="button" className={outlineButton} disabled={link.isPending} onClick={() => link.mutate(i.id)}>{link.isPending ? "Checking…" : i.externalAccountId ? "Check again" : "Link installation"}</button></Row>}
                {i.status === "disconnected" && i.provider === "github" && <Row title="Reconnect" text="Re-install the App to resume syncing."><button type="button" className={primaryButton} onClick={install}>Reconnect</button></Row>}
                {i.provider === "registry" && i.status !== "disconnected" && <Row title={isKeyless ? "Verify (keyless)" : "Verify"} text={isKeyless ? "Check that the cloud accepts this cell's token for this connection (after configuring the trust under Identity)." : "Check the stored credentials against the registry now."}><button type="button" className={isKeyless && !i.settings?.verified ? primaryButton : outlineButton} disabled={verify.isPending} onClick={() => verify.mutate(i.id)}>{verify.isPending ? "Verifying…" : "Verify"}</button></Row>}
                {publicKey && !i.settings?.verified && <Row title="Test connection" text="After adding the deploy key on the repository."><button type="button" className={primaryButton} disabled={verify.isPending} onClick={() => verify.mutate(i.id)}>{verify.isPending ? "Testing…" : "Test connection"}</button></Row>}
                {i.status !== "disconnected" && i.externalAccountId && <Row title="Sync now" text={i.provider === "registry" ? "Registry connections are used on demand by image syncs." : "Refresh the list of repositories, branches and tags."}>
                  <button type="button" className={outlineButton} disabled={sync.isPending || i.provider === "registry"} onClick={() => sync.mutate(i.id)}>{sync.isPending ? "Syncing…" : "Sync now"}</button></Row>}
                {i.status !== "disconnected" && i.externalAccountId && !i.inherited && <Row title="Disconnect" text="Stops syncing; the connection and its repositories stay, marked disconnected.">
                  <button type="button" className={outlineButton} disabled={disconnect.isPending} onClick={() => { if (window.confirm(`Disconnect ${i.name}?`)) disconnect.mutate(i.id, { onSuccess: onClose }); }}>Disconnect</button></Row>}
                {!i.inherited && <Row title="Delete" text="Removes the connection, its repositories and their links to services. Cannot be undone.">
                  <button type="button" className={dangerButton} disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete ${i.name}? Its repositories and their links to services are removed.`)) remove.mutate(i.id, { onSuccess: onClose }); }}>Delete</button></Row>}
                {!i.inherited && remove.error instanceof ApiError && remove.error.status === 409 && <Row title="Images pull through this connection" text={remove.error.message}>
                  <button type="button" className={dangerButton} disabled={remove.isPending} onClick={() => remove.mutate({ id: i.id, force: true }, { onSuccess: onClose })}>Detach images and delete</button></Row>}
                {i.inherited && <p className={`text-sm ${muted}`}>This connection is inherited from {i.scope.type.toLowerCase()} {i.scope.name}; manage it there.</p>}
              </div>
              {sync.isSuccess && <p className="text-sm text-success-600">Sync started — repositories refresh in a moment ({relativeTime(new Date().toISOString())}).</p>}
              {verify.isSuccess && <p className="text-sm text-success-600">Connection verified.</p>}
              {err ? <ErrorNotice error={err} /> : null}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Row({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <div className="min-w-0"><p className="text-sm font-medium text-gray-800 dark:text-white/90">{title}</p><p className={`text-xs ${muted}`}>{text}</p></div>
      {children}
    </div>
  );
}
