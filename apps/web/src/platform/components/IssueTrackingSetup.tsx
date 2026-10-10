import Badge from "@/components/ui/badge/Badge";
import { useEffectiveRemediationSettings, useIntegrations, useOrganizationRepositories, useProviders, useRemediationSettings, useUpdateRemediationSettings } from "@/platform/api/hooks";
import type { EffectiveRemediationSettings, Integration, IssueProvider, ScopeType } from "@/platform/api/types";
import { cn } from "@/utils";
import { useState } from "react";
import { Link } from "react-router";
import { ConnectWizard, type ConnectKind } from "./ConnectWizard";
import { BrandIcon } from "./EnvironmentManager";
import { Card, ErrorNotice, inputClass, muted, outlineButton, primaryButton } from "./ui";

type Choice = "" | IssueProvider;
const ORDER: ScopeType[] = ["PROJECT", "TEAM", "WORKSPACE", "ORGANIZATION"];
const SCOPE_PATH: Partial<Record<ScopeType, string>> = { ORGANIZATION: "organizations", WORKSPACE: "workspaces", TEAM: "teams", PROJECT: "projects" };

const OPTIONS: { value: Choice; title: string; brand?: "github" | "gitlab" | "bitbucket" | "jira"; text: string }[] = [
  { value: "", title: "Automatic", text: "Each service's repository host (GitHub, GitLab, Bitbucket); services on a plain git host use Jira." },
  { value: "github", title: "GitHub Issues", brand: "github", text: "In the service's repository, optionally added to a Projects board." },
  { value: "gitlab", title: "GitLab issues", brand: "gitlab", text: "In the service's GitLab project." },
  { value: "bitbucket", title: "Bitbucket issues", brand: "bitbucket", text: "In the service's repository (issue tracker must be enabled)." },
  { value: "jira", title: "Jira Cloud", brand: "jira", text: "In a Jira project, through the nearest Jira connection." },
];

/**
 * Setup → Issue tracking for one scope. Pick the tracker first; only that tracker's settings are shown.
 * Stored per scope as overrides; blank = inherit project → team → workspace → organization.
 */
export function IssueTrackingSetup({ organizationId, scopeType, scopeId, scopeName, projectId }: { organizationId: string; scopeType: ScopeType; scopeId: string; scopeName: string; projectId?: string }) {
  const scope = `${SCOPE_PATH[scopeType] ?? "projects"}/${scopeId}`;
  const settings = useRemediationSettings(scope);
  const effective = useEffectiveRemediationSettings(projectId);
  const save = useUpdateRemediationSettings(scope);
  const integrations = useIntegrations(organizationId);
  const repositories = useOrganizationRepositories(organizationId);
  const providers = useProviders();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const [wizard, setWizard] = useState<ConnectKind | null>(null);
  const s = settings.data;
  if (!s) return null;
  const eff = effective.data;
  const isOrg = scopeType === "ORGANIZATION";
  const cur: Choice = choice ?? s.issueProvider ?? "";
  const curKey = key ?? s.jiraProjectKey ?? "";
  const curBoard = board ?? s.issueBoard ?? "";
  const dirty = cur !== (s.issueProvider ?? "") || curKey !== (s.jiraProjectKey ?? "") || curBoard !== (s.issueBoard ?? "");
  const chainIds = new Set(eff ? eff.chain.map((c) => c.scopeId) : [scopeId, organizationId]);
  const applies = (i: Integration) => chainIds.has(i.scope.id) || i.scope.type === "ORGANIZATION";
  const rank = (i: Integration) => (i.scope.id === scopeId ? 0 : ORDER.indexOf(i.scope.type) + 1);
  const ofKind = (p: IssueProvider) => (integrations.data ?? []).filter((i) => applies(i) && (p === "github" ? i.provider === "github" || i.provider === "github_token" : i.provider === p)).sort((a, b) => rank(a) - rank(b));
  const reposOn = (p: IssueProvider) => { const ids = new Set(ofKind(p).map((i) => i.id)); return (repositories.data ?? []).filter((r) => ids.has(r.integrationId)).length; };
  const from = (k: keyof EffectiveRemediationSettings["sources"]) => { const src = eff?.sources[k]; return src ? (src.scopeId === scopeId ? "set here" : `inherited from ${src.scopeType.toLowerCase()} ${src.name}`) : "default"; };
  const where = (i: Integration) => (i.scope.id === scopeId ? `at this ${scopeType.toLowerCase()}` : `inherited from ${i.scope.type.toLowerCase()} ${i.scope.name}`);
  const effectiveChoice: Choice = cur || eff?.issueProvider || "";

  const ConnectionList = ({ p, connectKind, empty }: { p: IssueProvider; connectKind: ConnectKind; empty: string }) => {
    const list = ofKind(p);
    return (
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-gray-800 dark:text-white/90">Connections that apply here</p>
          <button type="button" className={outlineButton} disabled={!providers.data} onClick={() => setWizard(connectKind)}>Connect at this {scopeType.toLowerCase()}</button>
        </div>
        {list.length === 0 ? <p className={`mt-2 text-sm ${muted}`}>{empty} <Link to="/connections" className="text-brand-500 hover:underline">Connections page →</Link></p> : (
          <ul className="mt-2 space-y-2">
            {list.map((i, idx) => (
              <li key={i.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-800">
                <BrandIcon name={p} className="size-6" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-800 dark:text-white/90">{i.name}</p><p className={`text-xs ${muted}`}>{where(i)}{p !== "jira" ? ` · ${(repositories.data ?? []).filter((r) => r.integrationId === i.id).length} repositories` : ""}</p></div>
                {p === "jira" && idx === 0 && <Badge size="sm" color="success">used</Badge>}
                {i.status === "error" && <Badge size="sm" color="error">error</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Card title="Issue tracking" description={`Where "Create issue" sends remediation work for the ${scopeName}. ${isOrg ? "This is the organization default." : "Blank = inherit from the parent scope; a choice here applies to everything below it."}`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          {OPTIONS.map((o) => {
            const selected = cur === o.value;
            const n = o.value ? (o.value === "jira" ? ofKind("jira").length : reposOn(o.value)) : 0;
            return (
              <button key={o.value} type="button" onClick={() => setChoice(o.value)} className={cn("flex h-full flex-col rounded-2xl border p-4 text-start transition", selected ? "border-brand-500 bg-brand-50 shadow-theme-xs dark:bg-brand-500/10" : "border-gray-200 hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700")}>
                <div className="flex items-center justify-between gap-2">
                  {o.brand ? <BrandIcon name={o.brand} className="size-8" /> : <span className="inline-flex size-8 items-center justify-center rounded-lg bg-gray-100 text-sm font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-300">A</span>}
                  {o.value && n > 0 && <Badge size="sm" color="light">{o.value === "jira" ? `${n} connection${n === 1 ? "" : "s"}` : `${n} repo${n === 1 ? "" : "s"}`}</Badge>}
                  {!o.value && !isOrg && eff?.issueProvider && <Badge size="sm" color="light">inherits {eff.issueProvider}</Badge>}
                </div>
                <p className="mt-3 text-sm font-semibold text-gray-800 dark:text-white/90">{o.title}</p>
                <p className={`mt-1 text-xs leading-relaxed ${muted}`}>{o.text}</p>
              </button>
            );
          })}
        </div>
      </Card>

      {(effectiveChoice === "github" || (effectiveChoice === "" && reposOn("github") > 0)) && (
        <Card title="GitHub" description="Issues open in the service repository through the GitHub connection it came from. The App or token needs Issues: read & write; for boards also the organization permission Projects: read & write.">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ConnectionList p="github" connectKind="github_token" empty="No GitHub connection applies here; a deploy-key (git) connection cannot open issues." />
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-white/90">Projects board (optional)</p>
              <input className={`${inputClass} mt-1`} placeholder={eff?.issueBoard && !s.issueBoard ? eff.issueBoard : "https://github.com/orgs/acme/projects/5"} value={curBoard} onChange={(e) => setBoard(e.target.value)} />
              <p className={`mt-1 text-xs ${muted}`}>Every created issue is added to this board. {eff && <>({from("issueBoard")})</>}</p>
            </div>
          </div>
        </Card>
      )}
      {(effectiveChoice === "gitlab" || (effectiveChoice === "" && reposOn("gitlab") > 0)) && (
        <Card title="GitLab" description={"Issues open in the service's GitLab project. The group/project token needs the api scope. GitLab boards are label-driven: an issue appears on a board when it carries the board's labels (issues are created with the label \"security\")."}>
          <ConnectionList p="gitlab" connectKind="gitlab" empty="No GitLab connection applies here." />
        </Card>
      )}
      {(effectiveChoice === "bitbucket" || (effectiveChoice === "" && reposOn("bitbucket") > 0)) && (
        <Card title="Bitbucket" description={"Issues open in the service's Bitbucket repository; enable its issue tracker under Repository settings → Issue tracker. Bitbucket Cloud has no boards: teams that plan in Jira should choose Jira instead."}>
          <ConnectionList p="bitbucket" connectKind="bitbucket" empty="No Bitbucket connection applies here." />
        </Card>
      )}
      {(effectiveChoice === "jira" || effectiveChoice === "") && (
        <Card title="Jira Cloud" description={effectiveChoice === "jira" ? "Issues open in the Jira project below through the nearest connection on the chain (this scope → team → workspace → organization)." : "Fallback for services whose repository host has no issues API (plain git). Configure it if any such service exists here."}>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ConnectionList p="jira" connectKind="jira" empty="No Jira connection applies here." />
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-white/90">Jira project key</p>
              <input className={`${inputClass} mt-1 w-48`} placeholder={eff?.jiraProjectKey && !s.jiraProjectKey ? eff.jiraProjectKey : "SEC"} value={curKey} onChange={(e) => setKey(e.target.value)} />
              <p className={`mt-1 text-xs ${muted}`}>{eff && <>({from("jiraProjectKey")})</>}</p>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 px-5 py-4 dark:border-gray-800">
        <button type="button" className={primaryButton} disabled={save.isPending || !dirty} onClick={() => save.mutate({ issueProvider: (cur || null) as IssueProvider | null, jiraProjectKey: curKey.trim() || null, issueBoard: curBoard.trim() || null })}>{save.isPending ? "Saving…" : "Save"}</button>
        {!isOrg && (s.issueProvider || s.jiraProjectKey || s.issueBoard) && <button type="button" className={outlineButton} onClick={() => { setChoice(""); setKey(""); setBoard(""); save.mutate({ issueProvider: null, jiraProjectKey: null, issueBoard: null }); }}>Remove overrides (inherit)</button>}
        {eff && <p className={`text-xs ${muted}`}>Effective for this project: {eff.issueProvider ? OPTIONS.find((o) => o.value === eff.issueProvider)?.title : "Automatic"} ({from("issueProvider")}){eff.jiraProjectKey ? ` · Jira ${eff.jiraProjectKey} (${from("jiraProjectKey")})` : ""}{eff.issueBoard ? ` · board (${from("issueBoard")})` : ""}.</p>}
        {save.error ? <ErrorNotice error={save.error} /> : null}
      </div>
      {wizard && <ConnectWizard organizationId={organizationId} scopeType={scopeType} scopeId={scopeId} scopeName={scopeName} providers={providers.data ?? []} initialKind={wizard} onClose={() => setWizard(null)} />}
    </div>
  );
}
