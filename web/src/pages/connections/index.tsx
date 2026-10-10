import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { useIntegrations, useNotificationCapabilities, useNotificationChannels, useOrganizationRepositories, useProjects, useProviders, useTeams, useWorkspaces } from "@/platform/api/hooks";
import type { Organization, ScopeType } from "@/platform/api/types";
import { ConnectWizard, type ConnectKind } from "@/platform/components/ConnectWizard";
import { BRAND_ICON, BrandIcon, providerBrand } from "@/platform/components/EnvironmentManager";
const regBrand = (i: { provider: string; authType: string; settings?: Record<string, unknown> | null }) => providerBrand(i.provider, i.authType, i.settings?.baseUrl);
import { IntegrationsPanel } from "@/platform/components/IntegrationsPanel";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { ErrorNotice, inputClass, muted, SelectField } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { cn } from "@/utils";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";

type Card = { id: string; title: string; text: string; brand: keyof typeof BRAND_ICON | "webhook"; kind?: ConnectKind; channel?: "slack" | "teams" | "email" | "webhook"; badge?: string; to?: string };
const CATALOG: { title: string; blurb: string; cards: Card[] }[] = [
  { title: "Source code", blurb: "Where your services live. Repositories are scanned for dependencies, secrets and infrastructure code.", cards: [
    { id: "github-app", title: "GitHub", text: "Install the platform App: one click, webhooks, no personal tokens.", brand: "github", kind: "github_app", badge: "recommended" },
    { id: "github-own", title: "GitHub · your own App", text: "Your organization's GitHub App (App id, private key, webhook secret).", brand: "github", kind: "github_own_app" },
    { id: "github-token", title: "GitHub · token", text: "A fine-grained personal access token. Quick for a trial.", brand: "github", kind: "github_token" },
    { id: "gitlab", title: "GitLab", text: "gitlab.com or self-managed, with a group or project access token.", brand: "gitlab", kind: "gitlab" },
    { id: "bitbucket", title: "Bitbucket Cloud", text: "All repositories of a workspace, with an app password or access token.", brand: "bitbucket", kind: "bitbucket" },
    { id: "git", title: "Any git server", text: "Bitbucket, Azure DevOps, Gitea, internal servers: one repository over HTTPS or SSH.", brand: "git", kind: "git" },
  ] },
  { title: "Container registries", blurb: "Images, tags and digests are read from here and scanned; deployments are recognised by digest.", cards: [
    { id: "matelot", title: "Matelot registry", text: "Built in: a namespaced registry for a workspace, team or project. Scanned on push, promoted per environment, CI login with the CI token.", brand: "matelot", kind: "matelot", badge: "built-in" },
    { id: "ecr", title: "AWS ECR", text: "IAM access key exchanged for 12-hour tokens; also used for CI logins.", brand: "ecr", kind: "ecr" },
    { id: "acr", title: "Azure Container Registry", text: "Service principal with AcrPull, exchanged for short-lived tokens.", brand: "acr", kind: "acr" },
    { id: "gar", title: "Google Artifact Registry / GCR", text: "Service-account key exchanged for 1-hour tokens; also used for CI logins.", brand: "gar", kind: "gar" },
    { id: "registry", title: "Docker Hub · GHCR · Harbor", text: "Robot or read token for any OCI v2 registry.", brand: "docker", kind: "registry" },
  ] },
  { title: "Issue tracking", blurb: "Remediation opens issues with severity, component, fix version, where it runs and the SLA date. Where they go is set per project, team, workspace or organization under Remediation → SLAs & issues; by default the host of the service repository, else the nearest Jira connection.", cards: [
    { id: "jira", title: "Jira Cloud", text: "Atlassian e-mail + API token; issues land in the project key you choose.", brand: "jira", kind: "jira" },
    { id: "github-issues", title: "GitHub Issues", text: "Nothing to set up: issues open in the service's GitHub repository.", brand: "github", to: "#source-code", badge: "built-in" },
    { id: "gitlab-issues", title: "GitLab issues", text: "Built in: issues open in the service's GitLab project.", brand: "gitlab", to: "#source-code", badge: "built-in" },
    { id: "bitbucket-issues", title: "Bitbucket issues", text: "Built in when the repository has its issue tracker enabled; otherwise use Jira.", brand: "bitbucket", to: "#source-code", badge: "built-in" },
  ] },
  { title: "Notifications", blurb: "Where people are told when a decision is needed: failed gates, rejected or production deployments, SLA breaches, KEV in production, expiring exceptions, committed secrets.", cards: [
    { id: "slack", title: "Slack", text: "Incoming webhook. Native message with fields and a button.", brand: "slack", channel: "slack" },
    { id: "teams", title: "Microsoft Teams", text: "Incoming webhook or Power Automate flow. Adaptive Card.", brand: "teams", channel: "teams" },
    { id: "email", title: "E-mail", text: "Recipient list, sent through the cell's SMTP server.", brand: "email", channel: "email" },
    { id: "webhook", title: "Webhook", text: "JSON POST to any HTTPS endpoint of yours.", brand: "webhook", channel: "webhook" },
  ] },
];

function Mark({ brand, className }: { brand: Card["brand"]; className?: string }) {
  return brand === "webhook" ? <span className={cn("inline-flex items-center justify-center rounded-xl bg-gray-100 font-mono text-sm font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-300", className)}>{"{ }"}</span> : <BrandIcon name={brand} className={className} />;
}

function Connections({ organization }: { organization: Organization }) {
  const [params] = useSearchParams();
  const integrations = useIntegrations(organization.id);
  const repositories = useOrganizationRepositories(organization.id);
  const channels = useNotificationChannels(organization.id);
  const caps = useNotificationCapabilities();
  const providers = useProviders();
  const workspaces = useWorkspaces(organization.id);
  const teams = useTeams(organization.id);
  const projects = useProjects(organization.id);
  const [q, setQ] = useState("");
  const [wizard, setWizard] = useState<ConnectKind | null>(null);
  const scopes = useMemo(() => [
    { type: "ORGANIZATION" as ScopeType, id: organization.id, label: `Organization · ${organization.name}`, name: organization.name },
    ...(workspaces.data ?? []).map((w) => ({ type: "WORKSPACE" as ScopeType, id: w.id, label: `Workspace · ${w.name}`, name: w.name })),
    ...(teams.data ?? []).map((t) => ({ type: "TEAM" as ScopeType, id: t.id, label: `Team · ${t.workspaceName} / ${t.name}`, name: t.name })),
    ...(projects.data ?? []).map((p) => ({ type: "PROJECT" as ScopeType, id: p.id, label: `Project · ${p.teamName} / ${p.name}`, name: p.name })),
  ], [organization, workspaces.data, teams.data, projects.data]);
  const [scopeKey, setScopeKey] = useState(`ORGANIZATION:${organization.id}`);
  const scope = scopes.find((s) => `${s.type}:${s.id}` === scopeKey) ?? scopes[0]!;
  const repoCount = (id: string) => (repositories.data ?? []).filter((r) => r.integrationId === id).length;
  const connectedId = params.get("connected");
  const error = params.get("error");
  const ints = integrations.data ?? [];
  const chans = channels.data ?? [];
  const counts: Record<string, number> = {
    "github-app": ints.filter((i) => i.provider === "github").length, "github-own": 0, "github-token": ints.filter((i) => i.provider === "github_token").length,
    gitlab: ints.filter((i) => i.provider === "gitlab").length, git: ints.filter((i) => i.provider === "git").length,
    // by cloud, whatever the auth (stored secret, keyless, or a token to a cloud host)
    ecr: ints.filter((i) => i.provider === "registry" && regBrand(i) === "ecr").length, acr: ints.filter((i) => i.provider === "registry" && regBrand(i) === "acr").length, gar: ints.filter((i) => i.provider === "registry" && regBrand(i) === "gar").length, registry: ints.filter((i) => i.provider === "registry" && !["ecr", "acr", "gar"].includes(regBrand(i))).length,
    jira: ints.filter((i) => i.provider === "jira").length, matelot: ints.filter((i) => i.provider === "matelot").length, bitbucket: ints.filter((i) => i.provider === "bitbucket").length,
    slack: chans.filter((c) => c.kind === "slack").length, teams: chans.filter((c) => c.kind === "teams").length, email: chans.filter((c) => c.kind === "email").length, webhook: chans.filter((c) => c.kind === "webhook").length,
  };
  const needle = q.trim().toLowerCase();
  const sections = CATALOG.map((s) => ({ ...s, cards: s.cards.filter((c) => !needle || `${c.title} ${c.text} ${s.title}`.toLowerCase().includes(needle)) })).filter((s) => s.cards.length);
  const total = ints.length + chans.length;
  return (
    <div className="space-y-8">
      {connectedId && <div className="rounded-xl border border-success-500/30 bg-success-50 px-4 py-3 text-sm text-success-600 dark:bg-success-500/15 dark:text-success-500">GitHub connected. Repositories are being read now.</div>}
      {error === "expired_state" && <div className="rounded-xl border border-warning-500/30 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:bg-warning-500/10 dark:text-warning-400">The installation link had expired by the time GitHub sent you back (links are valid 15 minutes). The App is installed on GitHub{params.get("installation") ? ` (installation ${params.get("installation")})` : ""}; open the pending GitHub connection below → Manage → Actions → <strong>Link existing installation</strong>, or restart with Install on GitHub.</div>}
      {error && error !== "expired_state" && <ErrorNotice error={`The connection did not complete (${error}). Start again from this page.`} />}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h3 className="text-2xl font-semibold text-gray-800 dark:text-white/90">Connections</h3>
          <p className={`mt-1 max-w-2xl text-sm ${muted}`}>Everything Matelot talks to: code hosts, registries, issue trackers and the places people get notified. {total} connected.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input className={`${inputClass} sm:w-72`} placeholder="Search connections…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex items-center gap-2"><span className={`whitespace-nowrap text-sm ${muted}`}>Connect at</span><SelectField ariaLabel="Level" value={scopeKey} onChange={setScopeKey} options={scopes.map((s) => ({ value: `${s.type}:${s.id}`, label: s.label }))} className="w-72" /></div>
        </div>
      </div>

      {sections.map((s) => (
        <section key={s.title} id={s.title.toLowerCase().replace(/\s+/g, "-")}>
          <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">{s.title}</h4>
          <p className={`mb-4 text-sm ${muted}`}>{s.blurb}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {s.cards.map((c) => {
              const n = counts[c.id] ?? 0;
              const disabled = (c.kind === "matelot" && providers.data && !providers.data.find((p) => p.provider === "matelot")?.available) || (c.channel === "email" && caps.data && !caps.data.email) || (c.kind === "github_app" && providers.data && !providers.data.find((p) => p.provider === "github")?.platformApp);
              const inner = (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <Mark brand={c.brand} className="size-11 shrink-0" />
                    <span className="flex flex-col items-end gap-1">{n > 0 && <Badge size="sm" color="success">{n} connected</Badge>}{c.badge && <Badge size="sm" color={c.badge === "recommended" ? "primary" : "light"}>{c.badge}</Badge>}</span>
                  </div>
                  <p className="mt-4 text-sm font-semibold text-gray-800 dark:text-white/90">{c.title}</p>
                  <p className={`mt-1 flex-1 text-xs leading-relaxed ${muted}`}>{c.text}</p>
                  <p className={cn("mt-4 text-xs font-medium", disabled ? muted : "text-brand-500")}>{disabled ? (c.kind === "matelot" ? "Registry not enabled on this cell (REGISTRY_HOST)" : c.channel === "email" ? "SMTP not configured on this cell" : "Platform App not configured on this cell") : c.to ? "Connect the repository above ↑" : n > 0 ? "Add another →" : "Set up →"}</p>
                </>
              );
              const cls = cn("flex h-full flex-col rounded-2xl border bg-white p-5 text-start shadow-theme-xs transition dark:bg-white/3", disabled ? "cursor-not-allowed border-gray-200 opacity-60 dark:border-gray-800" : "border-gray-200 hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-theme-md dark:border-gray-800 dark:hover:border-brand-500/50");
              if (c.channel) return <Link key={c.id} to={disabled ? "#" : `/notifications?new=${c.channel}`} className={cls} aria-disabled={!!disabled}>{inner}</Link>;
              if (c.to) return <a key={c.id} href={c.to} className={cls}>{inner}</a>;
              return <button key={c.id} type="button" disabled={!!disabled} className={cls} onClick={() => setWizard(c.kind!)}>{inner}</button>;
            })}
          </div>
        </section>
      ))}

      <IntegrationsPanel organizationId={organization.id} scopeType={scope.type} scopeId={scope.id} scopeName={scope.name} integrations={ints} error={integrations.error} repoCount={repoCount} title="Connected sources, registries and trackers" />

      <div className="rounded-2xl border border-gray-200 p-5 dark:border-gray-800">
        <div className="flex items-center justify-between gap-4">
          <div><p className="text-sm font-semibold text-gray-800 dark:text-white/90">Notification channels</p><p className={`text-xs ${muted}`}>{chans.length} channel{chans.length === 1 ? "" : "s"} at the organization; workspace and project channels live in their own Notifications pages.</p></div>
          <Link to="/notifications" className="text-sm font-medium text-brand-500 hover:underline">Manage channels →</Link>
        </div>
        {chans.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{chans.map((c) => <span key={c.id} className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-700 dark:border-gray-800 dark:text-gray-300"><Mark brand={c.kind} className="size-4" />{c.name}<span className={cn("size-1.5 rounded-full", c.lastError ? "bg-error-500" : c.enabled ? "bg-success-500" : "bg-gray-400")} /></span>)}</div>}
      </div>

      {wizard && <ConnectWizard organizationId={organization.id} scopeType={scope.type} scopeId={scope.id} scopeName={scope.name} providers={providers.data ?? []} initialKind={wizard} onClose={() => setWizard(null)} />}
    </div>
  );
}

export default function ConnectionsPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Connections · ${productName}`} description="Code hosts, registries, issue trackers and notification channels" />
      <PageBreadcrumb pageTitle="Connections" />
      <OrganizationGate>{(organization) => <Connections key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
