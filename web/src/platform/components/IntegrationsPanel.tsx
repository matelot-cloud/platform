import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useDeleteIntegration, useDisconnectIntegration, useIntegrationInstallUrl, useProviders, useSyncIntegration, useVerifyIntegration } from "@/platform/api/hooks";
import type { Integration, IntegrationAuthType, IntegrationStatus, ScopeType } from "@/platform/api/types";
import { ConnectWizard } from "./ConnectWizard";
import { relativeTime } from "@/platform/format";
import { useState } from "react";
import { BrandIcon, providerBrand } from "./EnvironmentManager";
import { IntegrationManager } from "./IntegrationManager";
import { Card, EmptyState, ErrorNotice, muted, outlineButton, primaryButton, td, th, trBorder } from "./ui";

const STATUS_COLOR: Record<IntegrationStatus, "warning" | "success" | "error" | "light"> = { pending: "warning", connected: "success", error: "error", disconnected: "light" };
const AUTH_LABEL: Record<IntegrationAuthType, string> = { app: "GitHub App", token: "token", basic: "username/password", ssh: "SSH key", none: "public", aws: "AWS access key (ECR token exchange)", azure: "service principal (ACR token exchange)", gcp: "service account (Artifact Registry token exchange)", gcp_wif: "keyless · workload identity (GCP)", aws_wif: "keyless · workload identity (AWS)", azure_wif: "keyless · workload identity (Azure)" };
const LEVEL_LABEL: Record<ScopeType, string> = { ORGANIZATION: "organization", WORKSPACE: "workspace", TEAM: "team", PROJECT: "project", SERVICE: "service", ENVIRONMENT: "environment" };

export function describe(i: Integration): string {
  if (i.provider === "github") return i.externalAccountId ? `GitHub App · installation ${i.externalAccountId}${i.settings?.ownApp ? " · your own App" : ""}` : "GitHub App · not installed yet";
  if (i.provider === "github_token") return "GitHub · personal access token";
  if (i.provider === "gitlab") return `GitLab · ${i.settings?.baseUrl ? String(i.settings.baseUrl).replace(/^https?:\/\//, "") : "gitlab.com"} · ${AUTH_LABEL[i.authType]}`;
  if (i.provider === "matelot") return `Matelot registry · ${String(i.settings?.baseUrl ?? "")}/${String(i.settings?.namespace ?? "")}`;
  if (i.provider === "bitbucket") return `Bitbucket · ${String(i.settings?.owner ?? "")}`;
  if (i.provider === "jira") return `Jira · ${String(i.settings?.baseUrl ?? "").replace(/^https?:\/\//, "")}`;
  if (i.provider === "registry") return `${({ ecr: "AWS ECR", acr: "Azure Container Registry", gar: "Google Artifact Registry" } as Record<string, string>)[providerBrand(i.provider, i.authType, i.settings?.baseUrl)] ?? "Container registry"} · ${String(i.settings?.baseUrl ?? "").replace(/^https?:\/\//, "")} · ${AUTH_LABEL[i.authType]}`;
  return `git · ${String(i.settings?.repositoryUrl ?? "")} · ${AUTH_LABEL[i.authType]}`;
}

/**
 * Connected sources for one level (organization, workspace, team or project): the table plus the
 * "connect here" actions. Used by the Integrations page and the Project page.
 */
export function IntegrationsPanel({
  organizationId,
  scopeType,
  scopeId,
  scopeName,
  integrations,
  error,
  repoCount,
  title = "Connected sources",
  inheritedRepositories,
}: {
  organizationId: string;
  scopeType: ScopeType;
  scopeId: string;
  scopeName: string;
  integrations: Integration[];
  error: unknown;
  repoCount: (integrationId: string) => number;
  title?: string;
  /** Project page: repositories are usually inherited; show that before offering to connect. */
  inheritedRepositories?: number;
}) {
  const providers = useProviders();
  const installUrl = useIntegrationInstallUrl();
  const sync = useSyncIntegration(organizationId);
  const disconnect = useDisconnectIntegration(organizationId);
  const verify = useVerifyIntegration(organizationId);
  const remove = useDeleteIntegration(organizationId);
  const [dialog, setDialog] = useState(false);
  const [manage, setManage] = useState<string | null>(null);
  const managed = integrations.find((i) => i.id === manage) ?? null;

  const forbidden = isForbidden(error);

  return (
    <Card
      title={title}
      description={
        scopeType === "PROJECT"
          ? inheritedRepositories
            ? `${inheritedRepositories} repositories are already available to this project from connections above it — attach them to a service. Connect a source here only for code that lives elsewhere.`
            : "Normally your organization connects GitHub once and every project attaches repositories from it. Connect a source here only for code that lives elsewhere (another org, GitLab, Bitbucket, an internal server), or add a registry — including the built-in Matelot registry for this level."
          : `New connections are created at the ${LEVEL_LABEL[scopeType]} level (${scopeName}) and can be used by everything below it.`
      }
      flush
      actions={<button type="button" className={scopeType === "PROJECT" && inheritedRepositories ? outlineButton : primaryButton} onClick={() => setDialog(true)} disabled={forbidden || !providers.data}>Add connection</button>}
    >
      {forbidden ? (
        <EmptyState title="Not visible with your role">Connections are managed by whoever can connect at this level.</EmptyState>
      ) : error ? (
        <div className="p-4"><ErrorNotice error={error} /></div>
      ) : integrations.length === 0 ? (
        <EmptyState title={scopeType === "PROJECT" ? "No connection of its own" : "Nothing connected at this level"}>{scopeType === "PROJECT" ? "This project uses the repositories inherited from above. That is the normal case." : "Connect a source here, or use one inherited from a level above."}</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800">
              <tr>
                <th className={th}>Connection</th>
                <th className={th}>Level</th>
                <th className={th}>Status</th>
                <th className={th}>Repositories</th>
                <th className={th}>Last sync</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {integrations.map((i) => (
                <tr key={i.id} className={trBorder}>
                  <td className={td}>
                    <div className="flex items-center gap-3">
                      <BrandIcon name={providerBrand(i.provider, i.authType, i.settings?.baseUrl)} className="size-7" />
                      <div className="min-w-0">
                        <span className="font-medium text-gray-800 dark:text-white/90">{i.name}</span>
                        <span className={`block text-xs ${muted}`}>{describe(i)}</span>
                        {i.authType === "ssh" && !!i.settings?.publicKey && !i.settings?.verified ? <span className="block text-xs text-warning-600">Deploy key not verified yet — see Manage.</span> : null}
                        {i.lastError && <span className="block max-w-md truncate text-xs text-error-500" title={i.lastError}>{i.lastError}</span>}
                      </div>
                    </div>
                  </td>
                  <td className={td}>
                    <span className="text-sm text-gray-700 dark:text-gray-300">{LEVEL_LABEL[i.scope.type]} · {i.scope.name}</span>
                    {i.inherited && <Badge size="sm" color="light">inherited</Badge>}
                  </td>
                  <td className={td}><Badge size="sm" color={STATUS_COLOR[i.status]}>{i.status}</Badge></td>
                  <td className={`${td} ${muted}`}>{i.provider === "registry" ? "—" : repoCount(i.id)}</td>
                  <td className={`${td} ${muted}`}>{i.lastSyncedAt ? relativeTime(i.lastSyncedAt) : "never"}</td>
                  <td className={`${td} text-end`}><button type="button" className={outlineButton} onClick={() => setManage(i.id)}>Manage</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {managed && <IntegrationManager integration={managed} organizationId={organizationId} repoCount={repoCount(managed.id)} onClose={() => setManage(null)} />}
      {(sync.error || disconnect.error || installUrl.error || verify.error || remove.error) ? <div className="p-4"><ErrorNotice error={sync.error ?? disconnect.error ?? installUrl.error ?? verify.error ?? remove.error} /></div> : null}
      {dialog && <ConnectWizard organizationId={organizationId} scopeType={scopeType} scopeId={scopeId} scopeName={scopeName} providers={providers.data ?? []} onClose={() => setDialog(false)} />}
    </Card>
  );
}
