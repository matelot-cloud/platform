import Badge from "@/components/ui/badge/Badge";
import { useOrganizationRepositories } from "@/platform/api/hooks";
import { Card, EmptyState, muted, td, th, trBorder } from "@/platform/components/ui";
import { Link } from "react-router";
import { useWorkspace } from "./layout";

export default function WorkspaceRepositoriesPage() {
  const { organization, workspace } = useWorkspace();
  const all = useOrganizationRepositories(organization.id).data ?? [];
  const rows = all.filter((r) => (r.integrationScope && ((r.integrationScope.type === "WORKSPACE" && r.integrationScope.id === workspace.id) || r.integrationScope.type === "ORGANIZATION")) || r.services.length > 0);
  return (
    <Card title="Repositories" description="From this workspace's connections, the organization's, and those attached by its projects." flush>
      {rows.length === 0 ? <EmptyState title="No repositories yet"><Link to={`/workspaces/${workspace.id}/integrations`} className="text-brand-500 hover:underline">Connect a source</Link> for this workspace.</EmptyState> : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Repository</th><th className={th}>From</th><th className={th}>Protection</th><th className={th}>Attached to</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={trBorder}>
                <td className={td}><a href={r.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{r.fullName}</a></td>
                <td className={`${td} ${muted}`}>{r.integrationScope ? `${r.integrationScope.type.toLowerCase()} · ${r.integrationScope.name}` : r.integrationName}</td>
                <td className={td}>{r.branchProtection ? <Badge size="sm" color="success">protected</Badge> : <Badge size="sm" color="warning">unprotected</Badge>}</td>
                <td className={td}>{r.services.length ? r.services.map((s) => <Link key={s.serviceId} to={`/projects/${s.projectId}`} className="me-2 text-sm text-brand-500 hover:underline">{s.projectName} / {s.serviceName}</Link>) : <span className={`text-xs ${muted}`}>not attached</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
