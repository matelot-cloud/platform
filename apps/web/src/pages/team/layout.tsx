import { useTeams } from "@/platform/api/hooks";
import type { TeamRow } from "@/platform/api/types";
import { Card, EmptyState, muted } from "@/platform/components/ui";
import { Outlet, useOutletContext, useParams } from "react-router";
import { useWorkspace, type WorkspaceContext } from "../workspace/layout";

export interface TeamContext extends WorkspaceContext {
  team: TeamRow;
}

export function useTeam(): TeamContext {
  return useOutletContext<TeamContext>();
}

/** /workspaces/:workspaceId/teams/:teamId/* — a team inside its workspace (breadcrumb, card and menu come from the app layout). */
export default function TeamLayout() {
  const { organization, workspace } = useWorkspace();
  const { teamId = "" } = useParams();
  const teams = useTeams(organization.id);
  const team = (teams.data ?? []).find((t) => t.id === teamId && t.workspaceId === workspace.id);
  if (teams.isLoading) return <p className={`text-sm ${muted}`}>Loading…</p>;
  if (!team) return <Card flush><EmptyState title="Team not found">It may be archived, in another workspace, or outside your access.</EmptyState></Card>;
  return <Outlet key={team.id} context={{ organization, workspace, team } satisfies TeamContext} />;
}
