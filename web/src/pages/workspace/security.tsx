import { IssueTrackingSetup } from "@/platform/components/IssueTrackingSetup";
import { Vulnerabilities } from "@/pages/vulnerabilities";
import { RiskPage } from "@/pages/risk";
import { Components } from "@/pages/components";
import { PoliciesPanel } from "@/platform/components/PoliciesPanel";
import { useTeams } from "@/platform/api/hooks";
import { SelectField, muted } from "@/platform/components/ui";
import { useSearchParams, Link } from "react-router";
import { useWorkspace } from "./layout";
import { Queue, Settings, Tracked } from "@/pages/project/remediation";
import { CraBody } from "@/pages/project/cra";
import { Channels } from "@/pages/notifications";
import { Card, Tabs } from "@/platform/components/ui";
import { useState } from "react";

/** Team filter shared by the workspace security pages: `?team=<id>` narrows every list to that team's projects. */
export function useWorkspaceScope() {
  const { organization, workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const team = params.get("team") ?? "";
  const teams = (useTeams(organization.id).data ?? []).filter((t) => t.workspaceId === workspace.id);
  const scope = team ? `teams/${team}` : `workspaces/${workspace.id}`;
  const setTeam = (id: string) => setParams((p) => { if (id) p.set("team", id); else p.delete("team"); return p; }, { replace: true });
  const filter = (
    <div className="flex items-center gap-3">
      <span className={`text-sm ${muted}`}>Showing</span>
      <div className="w-60"><SelectField value={team} onChange={setTeam} options={[{ value: "", label: `Whole workspace · ${workspace.name}` }, ...teams.map((t) => ({ value: t.id, label: `Team · ${t.name}` }))]} /></div>
    </div>
  );
  return { organization, workspace, team, teams, scope, filter };
}

export function WorkspaceVulnerabilitiesPage() { const { organization, scope, filter } = useWorkspaceScope(); return <div className="space-y-4">{filter}<Vulnerabilities key={scope} organization={organization} scope={scope} /></div>; }
export function WorkspaceRiskPage() { const { organization, scope, filter } = useWorkspaceScope(); return <div className="space-y-4">{filter}<RiskPage key={scope} organization={organization} scope={scope} /></div>; }
export function WorkspaceComponentsPage() { const { organization, scope, filter } = useWorkspaceScope(); return <div className="space-y-4">{filter}<Components key={scope} organization={organization} scope={scope} /></div>; }
export function WorkspaceSecurityPoliciesPage() { const { organization, workspace, teams, team } = useWorkspaceScope(); const t = teams.find((x) => x.id === team); return <PoliciesPanel organization={organization} scope={t ? { type: "team", id: t.id, name: t.name } : { type: "workspace", id: workspace.id, name: workspace.name }} teamChoices={teams.map((x) => ({ id: x.id, name: x.name }))} />; }

export function WorkspaceRemediationPage() {
  const { workspace, team, scope, filter } = useWorkspaceScope();
  const [tab, setTab] = useState<"queue" | "tracked" | "settings">("queue");
  return <div className="space-y-4">{filter}<Card flush><Tabs value={tab} onChange={setTab} items={[{ value: "queue", label: "Fix first" }, { value: "tracked", label: "Tracked" }, { value: "settings", label: "SLAs" }]} /></Card>{tab === "queue" && <Queue key={scope} projectId={scope} />}{tab === "tracked" && <Tracked key={scope} projectId={scope} />}{tab === "settings" && <div className="space-y-4"><Settings scope={scope} scopeLabel={scope.startsWith("teams/") ? "team" : `workspace ${workspace.name}`} /><p className={`text-sm ${muted}`}>Where issues are opened is configured under <Link to={`/workspaces/${workspace.id}/issue-tracking${team ? `?team=${team}` : ""}`} className="text-brand-500 hover:underline">Setup → Issue tracking</Link>.</p></div>}</div>;
}
export function WorkspaceCraPage() { const { scope, filter } = useWorkspaceScope(); return <div className="space-y-4">{filter}<CraBody key={scope} scope={scope} /></div>; }
export function WorkspaceNotificationsPage() { const { organization, workspace, team, teams, scope } = useWorkspaceScope(); const t = teams.find((x) => x.id === team); const { filter } = useWorkspaceScope(); return <div className="space-y-4">{filter}<Channels key={scope} organization={organization} scope={scope} scopeLabel={t ? `team ${t.name}` : `workspace ${workspace.name}`} /></div>; }

export function WorkspaceIssueTrackingPage() {
  const { organization, workspace, team, teams, scope, filter } = useWorkspaceScope();
  const t = teams.find((x) => x.id === team);
  return <div className="space-y-4">{filter}<IssueTrackingSetup organizationId={organization.id} scopeType={team ? "TEAM" : "WORKSPACE"} scopeId={scope.split("/")[1]!} scopeName={team ? `team ${t?.name ?? ""}` : `workspace ${workspace.name}`} /></div>;
}
