import Badge from "@/components/ui/badge/Badge";
import { useProjectRepositories } from "@/platform/api/hooks";
import { Card, EmptyState, muted, td, th, trBorder } from "@/platform/components/ui";
import { relativeTime } from "@/platform/format";
import { Link } from "react-router";
import { useProject } from "./layout";

export default function ProjectRepositoriesPage() {
  const { project } = useProject();
  const repositories = useProjectRepositories(project.id);
  const rows = repositories.data ?? [];
  return (
    <Card title="Repositories" description="Available to this project from its own and inherited connections. Attach them to services on the Services page." flush>
      {rows.length === 0 ? (
        <EmptyState title="No repositories available yet"><Link to={`/projects/${project.id}/integrations`} className="text-brand-500 hover:underline">Connect a source</Link> for this project, or ask for one at the workspace or organization level.</EmptyState>
      ) : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Repository</th><th className={th}>From</th><th className={th}>Branch</th><th className={th}>Protection</th><th className={th}>Attached to</th><th className={th}>Synced</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const mine = r.services.filter((s) => s.projectId === project.id);
              return (
                <tr key={r.id} className={trBorder}>
                  <td className={td}><a href={r.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{r.fullName}</a></td>
                  <td className={`${td} ${muted}`}>{r.integrationScope ? `${r.integrationScope.type.toLowerCase()} · ${r.integrationScope.name}` : r.integrationName}</td>
                  <td className={`${td} ${muted}`}>{r.defaultBranch ?? "—"}</td>
                  <td className={td}>{r.branchProtection ? <Badge size="sm" color="success">protected</Badge> : <Badge size="sm" color="warning">unprotected</Badge>}</td>
                  <td className={td}>{mine.length ? mine.map((s) => s.serviceName).join(", ") : <Link to={`/projects/${project.id}/services`} className="text-sm text-brand-500 hover:underline">attach to a service</Link>}</td>
                  <td className={`${td} ${muted}`}>{r.lastSyncedAt ? relativeTime(r.lastSyncedAt) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
