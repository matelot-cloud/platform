import { useMatch } from "react-router";
import { useProjects, useWorkspaces } from "../api/hooks";
import type { ProjectRow, Workspace } from "../api/types";

/** GitLab-style: the URL is the context. /workspaces/:id/… or /projects/:id/… */
export function useRouteContext(organizationId: string | undefined): {
  workspace: Workspace | undefined;
  project: ProjectRow | undefined;
  workspaceId: string | undefined;
  projectId: string | undefined;
  loading: boolean;
} {
  const wsMatch = useMatch("/workspaces/:workspaceId/*");
  const projectMatch = useMatch("/projects/:projectId/*");
  const workspaces = useWorkspaces(organizationId);
  const projects = useProjects(organizationId);
  const project = projectMatch ? (projects.data ?? []).find((p) => p.id === projectMatch.params.projectId) : undefined;
  const workspaceId = project?.workspaceId ?? wsMatch?.params.workspaceId;
  const workspace = workspaceId ? (workspaces.data ?? []).find((w) => w.id === workspaceId) : undefined;
  return { workspace, project, workspaceId, projectId: projectMatch?.params.projectId, loading: workspaces.isLoading || projects.isLoading };
}
