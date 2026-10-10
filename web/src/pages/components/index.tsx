import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useComponentSearch } from "@/platform/api/hooks";
import type { Organization } from "@/platform/api/types";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, ErrorNotice, inputClass, muted, td, th, trBorder } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useState } from "react";
import { Link } from "react-router";

export function Components({ organization, scope }: { organization: Organization; scope?: string }) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const hits = useComponentSearch(organization.id, applied, scope);
  return (
    <Card title="Which services contain…" description="Searches the latest SBOM of every service in this scope. Type a package name (lodash, openssl, log4j) or a purl fragment." flush
      actions={<form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(q); }}><input className={`${inputClass} w-72`} placeholder="package name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><button type="submit" className="rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600">Search</button></form>}>
      {isForbidden(hits.error) ? <EmptyState title="Not visible with your role" /> : hits.error ? <div className="p-4"><ErrorNotice error={hits.error} /></div> : !applied ? <EmptyState title="Search across all SBOMs">Example: "lodash" shows every service and release that ships it, with the version.</EmptyState> : (hits.data ?? []).length === 0 ? <EmptyState title={`No service contains "${applied}"`} /> : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Component</th><th className={th}>Version</th><th className={th}>Service</th><th className={th}>Release / target</th><th className={th}>Licenses</th></tr></thead>
          <tbody>
            {(hits.data ?? []).map((h) => (
              <tr key={`${h.sbomId}-${h.id}`} className={trBorder}>
                <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{h.namespace ? `${h.namespace}/` : ""}{h.name}</span> <Badge size="sm" color="light">{h.type}</Badge></td>
                <td className={`${td} font-mono text-sm text-gray-800 dark:text-white/90`}>{h.version ?? "—"}</td>
                <td className={td}><Link to={`/projects/${h.projectId}/inventory`} className="text-brand-500 hover:underline">{h.projectName} / {h.serviceName}</Link></td>
                <td className={td}><Link to={`/projects/${h.projectId}/sboms/${h.sbomId}`} className="text-sm text-gray-700 hover:text-brand-500 dark:text-gray-300">{h.releaseVersion ? `release ${h.releaseVersion}` : h.targetRef}</Link><span className={`block text-xs ${muted}`}>{h.target}</span></td>
                <td className={`${td} ${muted}`}>{h.licenses.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function ComponentsPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Components · ${productName}`} description="Search SBOM components across the organization" />
      <PageBreadcrumb pageTitle="Components" />
      <OrganizationGate>{(organization) => <Components key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
