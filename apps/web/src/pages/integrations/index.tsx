import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import { useIntegrations, useOrganizationRepositories, useProjects, useTeams, useWorkspaces } from "@/platform/api/hooks";
import type { Organization, ScopeType } from "@/platform/api/types";
import { BrandIcon } from "@/platform/components/EnvironmentManager";
import { IntegrationsPanel } from "@/platform/components/IntegrationsPanel";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, ErrorNotice, SelectField } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

interface ScopeOption {
  type: ScopeType;
  id: string;
  label: string;
  name: string;
}

function Integrations({ organization }: { organization: Organization }) {
  const [params] = useSearchParams();
  const integrations = useIntegrations(organization.id);
  const repositories = useOrganizationRepositories(organization.id);
  const workspaces = useWorkspaces(organization.id);
  const teams = useTeams(organization.id);
  const projects = useProjects(organization.id);

  const scopes = useMemo<ScopeOption[]>(
    () => [
      { type: "ORGANIZATION", id: organization.id, label: `Organization · ${organization.name}`, name: organization.name },
      ...(workspaces.data ?? []).map((w): ScopeOption => ({ type: "WORKSPACE", id: w.id, label: `Workspace · ${w.name}`, name: w.name })),
      ...(teams.data ?? []).map((t): ScopeOption => ({ type: "TEAM", id: t.id, label: `Team · ${t.workspaceName} / ${t.name}`, name: t.name })),
      ...(projects.data ?? []).map((p): ScopeOption => ({ type: "PROJECT", id: p.id, label: `Project · ${p.teamName} / ${p.name}`, name: p.name })),
    ],
    [organization, workspaces.data, teams.data, projects.data],
  );
  const [scopeKey, setScopeKey] = useState(`ORGANIZATION:${organization.id}`);
  const scope = scopes.find((s) => `${s.type}:${s.id}` === scopeKey) ?? scopes[0]!;
  const [showAll, setShowAll] = useState(true);

  const list = (integrations.data ?? []).filter((i) => showAll || (i.scope.type === scope.type && i.scope.id === scope.id));
  const repoCount = (id: string) => (repositories.data ?? []).filter((r) => r.integrationId === id).length;
  const connectedId = params.get("connected");
  const error = params.get("error");

  return (
    <div className="space-y-6">
      {connectedId && <div className="rounded-xl border border-success-500/30 bg-success-50 px-4 py-3 text-sm text-success-600 dark:bg-success-500/15 dark:text-success-500">GitHub connected. Repositories are being synced in the background.</div>}
      {error && <ErrorNotice error={`The connection did not complete (${error}). Start again from this page.`} />}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-700 dark:text-gray-300">Connect at</span>
          <SelectField ariaLabel="Level" value={`${scope.type}:${scope.id}`} onChange={setScopeKey} options={scopes.map((s) => ({ value: `${s.type}:${s.id}`, label: s.label }))} className="w-80" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" className="size-4 rounded border-gray-300 text-brand-500" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all levels
        </label>
      </div>

      <IntegrationsPanel organizationId={organization.id} scopeType={scope.type} scopeId={scope.id} scopeName={scope.name} integrations={list} error={integrations.error} repoCount={repoCount} />

      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
        <Card title="What can be connected" flush>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {[
              { icon: "github" as const, title: "GitHub", text: "Install the platform's App with one click, register your organization's own App (webhooks, no personal tokens), or a deploy key for a single repository." },
              { icon: "gitlab" as const, title: "GitLab", text: "gitlab.com or self-managed, with a group or project access token (read_api) — not tied to a person." },
              { icon: "git" as const, title: "Any git server", text: "Bitbucket, Azure DevOps, Gitea, internal servers: one repository over HTTPS or SSH (deploy key generated here or your own)." },
              { icon: "docker" as const, title: "Container registries", text: "Docker Hub, GHCR, GitLab, Harbor or any v2 registry with a robot/read token, so images, tags and digests are read and scanned. The platform also has its own built-in registry." },
              { icon: "ecr" as const, title: "AWS Elastic Container Registry", text: "An IAM access key; the platform exchanges it for 12-hour tokens for syncing, scanning and CI logins (secops registry login --connection)." },
              { icon: "acr" as const, title: "Azure Container Registry", text: "A service principal with AcrPull; exchanged for short-lived ACR tokens the same way. Secrets never leave the cell." },
            ].map((x) => (
              <li key={x.title} className="flex gap-3 px-6 py-3"><BrandIcon name={x.icon} className="mt-0.5 size-6" /><span><span className="text-sm font-medium text-gray-800 dark:text-white/90">{x.title}</span><span className="block text-xs text-gray-500 dark:text-gray-400">{x.text}</span></span></li>
            ))}
          </ul>
        </Card>
        <Card title="Where to connect what">
          <ul className="list-disc space-y-1 ps-5 text-sm text-gray-700 dark:text-gray-400">
            <li><strong>Project</strong> — the repositories of one project only (a Bitbucket repo over SSH, a project token). Team leads and developers can do this themselves.</li>
            <li><strong>Team / workspace</strong> — a GitLab group or GitHub org shared by all the projects underneath.</li>
            <li><strong>Organization</strong> — company-wide connections such as a GitHub App installation; administrators only.</li>
            <li>A repository can be attached to a service only if its connection sits on the service's path: project, team, workspace or organization. Connections are inherited downward, never upward.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Integrations · ${productName}`} description="Connected systems" />
      <PageBreadcrumb pageTitle="Integrations" />
      <OrganizationGate>{(organization) => <Integrations key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
