import Badge from "@/components/ui/badge/Badge";
import { useEffectiveRemediationSettings, useIntegrations, useProviders, useRemediationSettings, useUpdateRemediationSettings } from "@/platform/api/hooks";
import type { EffectiveRemediationSettings, Integration, IssueProvider, ScopeType } from "@/platform/api/types";
import { useState } from "react";
import { ConnectWizard } from "./ConnectWizard";
import { BrandIcon } from "./EnvironmentManager";
import { Card, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField } from "./ui";

const PROVIDER: Record<IssueProvider, { label: string; brand: "github" | "gitlab" | "bitbucket" | "jira"; how: string }> = {
  github: { label: "GitHub Issues", brand: "github", how: "in the service's GitHub repository (GitHub App or token connection)" },
  gitlab: { label: "GitLab issues", brand: "gitlab", how: "in the service's GitLab project (token connection)" },
  bitbucket: { label: "Bitbucket issues", brand: "bitbucket", how: "in the service's Bitbucket repository (issue tracker must be enabled)" },
  jira: { label: "Jira Cloud", brand: "jira", how: "in the Jira project below, through the nearest Jira connection" },
};
const ORDER: ScopeType[] = ["PROJECT", "TEAM", "WORKSPACE", "ORGANIZATION"];

/**
 * Where remediation issues go for one scope (project / team / workspace / organization) and the Jira connections
 * that apply there. Settings store only overrides: "inherit" walks up project → team → workspace → organization.
 */
export function IssueTrackerPanel({ organizationId, scopeType, scopeId, scopeName, projectId }: { organizationId: string; scopeType: ScopeType; scopeId: string; scopeName: string; projectId?: string }) {
  const scope = `${scopeType === "ORGANIZATION" ? "organizations" : scopeType === "WORKSPACE" ? "workspaces" : scopeType === "TEAM" ? "teams" : "projects"}/${scopeId}`;
  const settings = useRemediationSettings(scope);
  const effective = useEffectiveRemediationSettings(projectId);
  const save = useUpdateRemediationSettings(scope);
  const integrations = useIntegrations(organizationId);
  const providers = useProviders();
  const [provider, setProvider] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const s = settings.data;
  if (!s) return null;
  const eff = effective.data;
  const isOrg = scopeType === "ORGANIZATION";
  // Jira connections that apply here: at this scope, or at any parent (inherited). Child-scope connections are not visible upwards.
  const chainIds = new Set(eff ? eff.chain.map((c) => c.scopeId) : [scopeId, organizationId]);
  const jira = (integrations.data ?? []).filter((i) => i.provider === "jira" && (chainIds.has(i.scope.id) || i.scope.type === "ORGANIZATION"));
  const rank = (i: Integration) => (i.scope.id === scopeId ? 0 : ORDER.indexOf(i.scope.type) + 1);
  jira.sort((a, b) => rank(a) - rank(b));
  const nearest = jira[0];
  const from = (k: keyof EffectiveRemediationSettings["sources"]) => { const src = eff?.sources[k]; return src ? (src.scopeId === scopeId ? "set here" : `inherited from ${src.scopeType.toLowerCase()} ${src.name}`) : "default"; };
  const curProvider = provider ?? s.issueProvider ?? "";
  const curKey = key ?? s.jiraProjectKey ?? "";
  const effectiveProvider = ((curProvider as IssueProvider) || eff?.issueProvider || "repo") as IssueProvider | "repo";
  return (
    <Card title="Issue tracker" description={`Where "Create issue" sends work for the ${scopeName}. ${isOrg ? "Organization default." : "Blank = inherit from the parent scope; set something here to override it for everything below."}`}>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">Issues go to</p>
            <SelectField ariaLabel="Issue provider" className="mt-1" value={curProvider} onChange={setProvider} options={[{ value: "", label: isOrg ? "Repository host (GitHub / GitLab / Bitbucket), else Jira" : `Inherit — ${eff?.issueProvider ? PROVIDER[eff.issueProvider].label : "repository host, else Jira"}` }, ...(Object.keys(PROVIDER) as IssueProvider[]).map((v) => ({ value: v, label: PROVIDER[v].label }))]} />
            <p className={`mt-1 text-xs ${muted}`}>{effectiveProvider === "repo" ? "Issues open on the host of each service's repository; services on a plain git host fall back to Jira." : `Issues open ${PROVIDER[effectiveProvider].how}.`} {eff && <>({from("issueProvider")})</>}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">Jira project key</p>
            <input className={`${inputClass} mt-1 w-48`} placeholder={eff?.jiraProjectKey && !s.jiraProjectKey ? eff.jiraProjectKey : "SEC"} value={curKey} onChange={(e) => setKey(e.target.value)} />
            <p className={`mt-1 text-xs ${muted}`}>Used when issues go to Jira. {eff && <>({from("jiraProjectKey")})</>}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={primaryButton} disabled={save.isPending} onClick={() => save.mutate({ issueProvider: (curProvider || null) as IssueProvider | null, jiraProjectKey: curKey.trim() || null })}>{save.isPending ? "Saving…" : "Save"}</button>
            {!isOrg && (s.issueProvider || s.jiraProjectKey) && <button type="button" className={outlineButton} onClick={() => { setProvider(""); setKey(""); save.mutate({ issueProvider: null, jiraProjectKey: null }); }}>Inherit</button>}
            {save.error ? <ErrorNotice error={save.error} /> : null}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">Jira connections that apply here</p>
            <button type="button" className={outlineButton} onClick={() => setWizard(true)} disabled={!providers.data}>Connect Jira at this {scopeType.toLowerCase()}</button>
          </div>
          {jira.length === 0 ? (
            <p className={`mt-2 text-sm ${muted}`}>None yet. Connect one here for this {scopeType.toLowerCase()} only, or on the Connections page for the whole organization. GitHub, GitLab and Bitbucket issues need no connection beyond the repository itself.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {jira.map((i) => (
                <li key={i.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-800">
                  <BrandIcon name="jira" className="size-6" />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-800 dark:text-white/90">{i.name}</p><p className={`text-xs ${muted}`}>{String(i.settings?.baseUrl ?? "").replace(/^https?:\/\//, "")} · {i.scope.id === scopeId ? `at this ${scopeType.toLowerCase()}` : `inherited from ${i.scope.type.toLowerCase()} ${i.scope.name}`}</p></div>
                  {i === nearest && <Badge size="sm" color="success">used</Badge>}
                  {i.status === "error" && <Badge size="sm" color="error">error</Badge>}
                </li>
              ))}
            </ul>
          )}
          <p className={`mt-2 text-xs ${muted}`}>The nearest connection wins: this {scopeType.toLowerCase()} → {scopeType === "PROJECT" ? "team → workspace → " : scopeType === "TEAM" ? "workspace → " : ""}organization. Repository-host issues (GitHub / GitLab / Bitbucket) use the connection the service repository came from.</p>
        </div>
      </div>
      {wizard && <ConnectWizard organizationId={organizationId} scopeType={scopeType} scopeId={scopeId} scopeName={scopeName} providers={providers.data ?? []} initialKind="jira" onClose={() => setWizard(false)} />}
    </Card>
  );
}
