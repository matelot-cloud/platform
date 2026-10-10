import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { CiSnippetBlock } from "./ci-snippets";
import { Modal } from "@/components/ui/modal";
import { useCreatePolicyFromTemplate, useDeletePolicy, usePolicyTemplates, useProjects, useSavePolicy, useScopePolicies, useTeams, useWorkspaces } from "@/platform/api/hooks";
import { ExceptionsPanel } from "./ExceptionsPanel";
import type { Organization, Policy, PolicyRules } from "@/platform/api/types";
import { Card, dangerLink, EmptyState, ErrorNotice, inputClass, linkButton, muted, outlineButton, primaryButton, SelectField, td, th, trBorder } from "@/platform/components/ui";
import { useState } from "react";

export interface ScopeRef { type: "organization" | "workspace" | "team" | "project"; id: string; name: string }

const SEV = [{ value: "", label: "no limit" }, { value: "critical", label: "critical" }, { value: "high", label: "high" }, { value: "medium", label: "medium" }, { value: "low", label: "low" }];
const KINDS = ["development", "staging", "production"];
const DEFAULT: PolicyRules = { maxSeverity: "high", blockKev: true, blockSecrets: true, maxIacSeverity: null, requireSbom: true, honourDecisions: true };

function describeRules(r: PolicyRules) {
  const out: string[] = [];
  if (r.maxSeverity) out.push(`no open vulnerability above ${r.maxSeverity}`);
  if (r.blockKev) out.push("no known-exploited (KEV)");
  if (r.blockSecrets) out.push("no secrets in code");
  if (r.maxIacSeverity) out.push(`no IaC issue ≥ ${r.maxIacSeverity}`);
  if (r.maxSastSeverity) out.push(`no code finding ≥ ${r.maxSastSeverity}`);
  if (r.requireSbom) out.push("SBOM required");
  return out.join(" · ") || "no rules";
}

export function PolicyDialog({ organization, policy, onClose, fixedScope, teamChoices }: { organization: Organization; policy: Policy | null; onClose: () => void; fixedScope?: ScopeRef; teamChoices?: { id: string; name: string }[] }) {
  const save = useSavePolicy(organization.id);
  const projects = useProjects(organization.id);
  const workspaces = useWorkspaces(organization.id);
  const teams = useTeams(organization.id);
  const [name, setName] = useState(policy?.name ?? "");
  const [description, setDescription] = useState(policy?.description ?? "");
  const [kinds, setKinds] = useState<string[]>(policy?.environmentKinds ?? ["production"]);
  const [rules, setRules] = useState<PolicyRules>(policy?.rules ?? DEFAULT);
  const [action, setAction] = useState<"block" | "warn">(policy?.action ?? "block");
  const [enforce, setEnforce] = useState(policy?.enforceOnDeploy ?? true);
  const [scope, setScope] = useState(fixedScope ? `${fixedScope.type}:${fixedScope.id}` : "organization:");
  const toggleKind = (k: string) => setKinds((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]));
  return (
    <Modal isOpen onClose={onClose} className="max-w-170 p-6 pe-20 lg:p-8 lg:pe-24">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate({ id: policy?.id, scope: policy ? undefined : { type: scope.split(":")[0] as "organization" | "workspace" | "team" | "project", id: scope.split(":")[1] }, name, description: description || undefined, environmentKinds: kinds, rules, action, enforceOnDeploy: enforce }, { onSuccess: onClose }); }} className="space-y-5">
        <h4 className="text-lg font-semibold text-gray-800 dark:text-white/90">{policy ? "Edit policy" : "New policy"}</h4>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div><Label htmlFor="pol-name">Name</Label><input id="pol-name" required autoFocus className={inputClass} placeholder="Production baseline" value={name} onChange={(e) => setName(e.target.value)} /></div>
          {!policy && (fixedScope ? <div><Label>Applies at</Label><SelectField value={scope} onChange={setScope} options={[{ value: `${fixedScope.type}:${fixedScope.id}`, label: `${fixedScope.type[0].toUpperCase()}${fixedScope.type.slice(1)} · ${fixedScope.name}` }, ...(teamChoices ?? []).map((t) => ({ value: `team:${t.id}`, label: `Team · ${t.name}` }))]} /><p className={`mt-1 text-xs ${muted}`}>Applies to everything underneath this level.</p></div> : <div><Label>Applies at</Label><SelectField value={scope} onChange={setScope} options={[{ value: "organization:", label: `Whole organization (${organization.name})` }, ...(workspaces.data ?? []).map((w) => ({ value: `workspace:${w.id}`, label: `Workspace · ${w.name}` })), ...(teams.data ?? []).map((t) => ({ value: `team:${t.id}`, label: `Team · ${t.name}` })), ...(projects.data ?? []).map((p) => ({ value: `project:${p.id}`, label: `Project · ${p.name}` }))]} /><p className={`mt-1 text-xs ${muted}`}>Applies to everything underneath; lower levels add their own policies on top.</p></div>)}
        </div>
        <div><Label htmlFor="pol-desc">Description</Label><input id="pol-desc" className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this policy protects and why" /></div>
        <div>
          <Label>Environments</Label>
          <div className="flex flex-wrap gap-2">{KINDS.map((k) => <label key={k} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} />{k}</label>)}<span className={`text-xs ${muted}`}>(none selected = every environment)</span></div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div><Label>Highest tolerated vulnerability severity</Label><SelectField value={rules.maxSeverity ?? ""} onChange={(v) => setRules({ ...rules, maxSeverity: (v || null) as PolicyRules["maxSeverity"] })} options={SEV} /><p className={`mt-1 text-xs ${muted}`}>Open findings above this level fail the gate.</p></div>
          <div><Label>Code findings (static analysis) at or above</Label><SelectField value={rules.maxSastSeverity ?? ""} onChange={(v) => setRules({ ...rules, maxSastSeverity: (v || null) as PolicyRules["maxSastSeverity"] })} options={[{ value: "", label: "ignore" }, ...SEV.slice(1)]} /></div>
          <div><Label>IaC misconfigurations at or above</Label><SelectField value={rules.maxIacSeverity ?? ""} onChange={(v) => setRules({ ...rules, maxIacSeverity: (v || null) as PolicyRules["maxIacSeverity"] })} options={[{ value: "", label: "ignore" }, ...SEV.slice(1)]} /></div>
        </div>
        <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <label className="flex items-center gap-2"><input type="checkbox" checked={rules.blockKev} onChange={(e) => setRules({ ...rules, blockKev: e.target.checked })} />No open vulnerability listed in CISA KEV (known exploited)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={rules.blockSecrets} onChange={(e) => setRules({ ...rules, blockSecrets: e.target.checked })} />No secret committed in the repository</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={rules.requireSbom} onChange={(e) => setRules({ ...rules, requireSbom: e.target.checked })} />The image must have an SBOM (be scanned)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={rules.honourDecisions} onChange={(e) => setRules({ ...rules, honourDecisions: e.target.checked })} />Findings marked accepted / false positive / not affected do not count</label>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div><Label>When violated</Label><SelectField value={action} onChange={(v) => setAction(v as "block" | "warn")} options={[{ value: "block", label: "Block — the gate fails (CI exit 2, pipeline stage fails)" }, { value: "warn", label: "Warn — reported, never blocks" }]} /></div>
          <label className="flex items-start gap-2 pt-6 text-sm text-gray-700 dark:text-gray-300"><input type="checkbox" className="mt-0.5" checked={enforce} onChange={(e) => setEnforce(e.target.checked)} disabled={action !== "block"} /><span>Also reject deployments<span className={`block text-xs ${muted}`}>matelot deploy / promote to a matching environment is refused when the gate fails</span></span></label>
        </div>
        {save.error ? <ErrorNotice error={save.error} /> : null}
        <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={save.isPending || !name.trim()}>{save.isPending ? "Saving…" : policy ? "Save" : "Create policy"}</button></div>
      </form>
    </Modal>
  );
}


/** Policies in force at one level (own + inherited), with creation at that level. */
export function PoliciesPanel({ organization, scope, teamChoices, showCi = false }: { organization: Organization; scope: ScopeRef; teamChoices?: { id: string; name: string }[]; showCi?: boolean }) {
  const policies = useScopePolicies(scope);
  const save = useSavePolicy(organization.id);
  const remove = useDeletePolicy();
  const projects = useProjects(organization.id);
  const workspaces = useWorkspaces(organization.id);
  const teams = useTeams(organization.id);
  const [dialog, setDialog] = useState<{ policy: Policy | null } | null>(null);
  const templates = usePolicyTemplates();
  const fromTemplate = useCreatePolicyFromTemplate();
  const scopeLabel = (p: Policy) => (p.scopeType === "ORGANIZATION" ? "organization" : p.scopeType === "PROJECT" ? `project · ${(projects.data ?? []).find((x) => x.id === p.scopeId)?.name ?? p.scopeId.slice(0, 8)}` : p.scopeType === "WORKSPACE" ? `workspace · ${(workspaces.data ?? []).find((x) => x.id === p.scopeId)?.name ?? p.scopeId.slice(0, 8)}` : p.scopeType === "TEAM" ? `team · ${(teams.data ?? []).find((x) => x.id === p.scopeId)?.name ?? p.scopeId.slice(0, 8)}` : p.scopeType.toLowerCase());
  const rows = (policies.data ?? []) as (Policy & { inherited?: boolean })[];
  return (
    <div className="space-y-6">
      <Card title={`Policies in force · ${scope.name}`} description={scope.type === "organization" ? "What must be true before something ships. Organization policies apply everywhere; workspaces, teams and projects add their own on top." : `Policies defined at this ${scope.type} plus those inherited from above. Inherited ones are edited where they were defined.`} flush actions={<button type="button" className={primaryButton} onClick={() => setDialog({ policy: null })}>New policy</button>}>
        {policies.error ? <div className="p-4"><ErrorNotice error={policies.error} /></div> : rows.length === 0 ? <EmptyState title="No policy in force">Start with a production baseline: no critical/high, no known-exploited, no secrets, SBOM required.</EmptyState> : (
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Policy</th><th className={th}>Defined at</th><th className={th}>Environments</th><th className={th}>Rules</th><th className={th}>On violation</th><th className={th} /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className={trBorder}>
                  <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{p.name}</span>{!p.enabled && <Badge size="sm" color="light">disabled</Badge>}{p.inherited && <Badge size="sm" color="light">inherited</Badge>}{p.description && <span className={`block text-xs ${muted}`}>{p.description}</span>}</td>
                  <td className={`${td} ${muted}`}>{scopeLabel(p)}</td>
                  <td className={td}>{p.environmentKinds.length ? p.environmentKinds.map((k) => <Badge key={k} size="sm" color={k === "production" ? "error" : "light"}>{k}</Badge>) : <span className={`text-xs ${muted}`}>all</span>}</td>
                  <td className={`${td} text-xs ${muted}`}>{describeRules(p.rules)}</td>
                  <td className={td}><Badge size="sm" color={p.action === "block" ? "error" : "warning"}>{p.action}</Badge>{p.enforceOnDeploy && <span className={`block text-xs ${muted}`}>rejects deployments</span>}</td>
                  <td className={`${td} text-end`}>{!p.inherited && <span className="inline-flex gap-3"><button type="button" className={linkButton} onClick={() => setDialog({ policy: p })}>Edit</button><button type="button" className={linkButton} onClick={() => save.mutate({ id: p.id, name: p.name, environmentKinds: p.environmentKinds, rules: p.rules, action: p.action, enforceOnDeploy: p.enforceOnDeploy, enabled: !p.enabled })}>{p.enabled ? "Disable" : "Enable"}</button><button type="button" className={dangerLink} onClick={() => { if (window.confirm(`Delete "${p.name}"?`)) remove.mutate(p.id); }}>Delete</button></span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Start from a template" description="Ready-made policies; created at this level and editable afterwards.">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(templates.data ?? []).map((t) => (
            <div key={t.id} className="flex flex-col rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <p className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-white/90">{t.name}<Badge size="sm" color={t.action === "block" ? "error" : "warning"}>{t.action}</Badge></p>
              <p className={`mt-1 flex-1 text-xs ${muted}`}>{t.description}</p>
              <p className={`mt-2 text-[11px] ${muted}`}>{describeRules(t.rules)}{t.environmentKinds.length ? ` · ${t.environmentKinds.join(", ")}` : " · all environments"}</p>
              <button type="button" className={`${outlineButton} mt-3 self-start`} disabled={fromTemplate.isPending} onClick={() => fromTemplate.mutate({ scope: { type: scope.type, id: scope.id }, template: t.id })}>Use template</button>
            </div>
          ))}
        </div>
        {fromTemplate.error ? <div className="mt-3"><ErrorNotice error={fromTemplate.error} /></div> : null}
      </Card>
      {scope.type !== "workspace" && scope.type !== "team" && <ExceptionsPanel organization={organization} scope={scope as { type: "organization" | "project"; id: string; name: string }} />}
      {showCi && <Card title="Use the gate in CI" description="The same evaluation the platform runs on every deployment; exit code 2 when a blocking policy fails, so the job stops before anything reaches the environment."><CiSnippetBlock input={{ intro: ["Gate before deploying; identical rules to the platform's own check."], vars: { MATELOT_SERVICE_ID: "<service id>", MATELOT_ENV_PROD: "<environment id>" }, job: "gate", manual: true, steps: ["matelot gate --env $MATELOT_ENV_PROD --image $IMAGE@$DIGEST      # exit 2 when a blocking policy fails", "matelot deploy --env $MATELOT_ENV_PROD --version {ref} --image $IMAGE@$DIGEST"] }} /></Card>}
      {dialog && <PolicyDialog organization={organization} policy={dialog.policy} onClose={() => setDialog(null)} fixedScope={scope.type === "organization" ? undefined : scope} teamChoices={teamChoices} />}
    </div>
  );
}
