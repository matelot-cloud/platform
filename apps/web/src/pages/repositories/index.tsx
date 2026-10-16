import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useOrganizationRepositories } from "@/platform/api/hooks";
import type { Organization } from "@/platform/api/types";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, ErrorNotice, inputClass, muted, td, th, trBorder } from "@/platform/components/ui";
import { relativeTime } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useState } from "react";
import { Link } from "react-router";

function Repositories({ organization }: { organization: Organization }) {
  const repositories = useOrganizationRepositories(organization.id);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const rows = (repositories.data ?? []).filter((r) => !needle || r.fullName.toLowerCase().includes(needle) || r.services.some((s) => s.serviceName.toLowerCase().includes(needle)));
  const orphans = (repositories.data ?? []).filter((r) => r.services.length === 0 && !r.archived).length;

  return (
    <Card
      title="Repositories"
      description={orphans ? `${orphans} not attached to any service yet — the first candidates of asset discovery.` : "Every repository the connected integrations can see, and the services they belong to."}
      flush
      actions={<input className={`${inputClass} w-72`} placeholder="Filter by name or service" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />}
    >
      {isForbidden(repositories.error) ? (
        <EmptyState title="Not visible with your role" />
      ) : repositories.error ? (
        <div className="p-4"><ErrorNotice error={repositories.error} /></div>
      ) : (repositories.data ?? []).length === 0 ? (
        <EmptyState title="No repositories yet"><Link to="/integrations" className="text-brand-500 hover:underline">Connect GitHub</Link> to inventory them.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800">
              <tr>
                <th className={th}>Repository</th>
                <th className={th}>Visibility</th>
                <th className={th}>Default branch</th>
                <th className={th}>Protection</th>
                <th className={th}>Services</th>
                <th className={th}>Synced</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={trBorder}>
                  <td className={td}>
                    <a href={r.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{r.fullName}</a>
                    {r.archived && <Badge size="sm" color="light">archived</Badge>}
                    <span className={`block text-xs ${muted}`}>{r.integrationName}{r.integrationScope ? ` (${r.integrationScope.type.toLowerCase()}: ${r.integrationScope.name})` : ""} · {Object.keys(r.languages ?? {}).slice(0, 3).join(", ") || "no languages"}</span>
                  </td>
                  <td className={`${td} ${muted}`}>{r.visibility ?? "—"}</td>
                  <td className={`${td} ${muted}`}>{r.defaultBranch ?? "—"}</td>
                  <td className={td}>{r.branchProtection ? <Badge size="sm" color="success">protected</Badge> : <Badge size="sm" color="warning">unprotected</Badge>}</td>
                  <td className={td}>
                    {r.services.length === 0 ? (
                      <span className={`text-xs ${muted}`}>not attached</span>
                    ) : (
                      r.services.map((s) => (
                        <Link key={s.serviceId} to={`/projects/${s.projectId}`} className="me-2 text-sm text-brand-500 hover:underline">{s.projectName} / {s.serviceName}</Link>
                      ))
                    )}
                  </td>
                  <td className={`${td} ${muted}`}>{r.lastSyncedAt ? relativeTime(r.lastSyncedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function RepositoriesPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Repositories · ${productName}`} description="Repository inventory" />
      <OrganizationGate>{(organization) => <Repositories key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
