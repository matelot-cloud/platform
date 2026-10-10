import { CodeBlock } from "@/platform/components/CodeBlock";
import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useAuditEvents } from "@/platform/api/hooks";
import type { AuditEvent, Organization } from "@/platform/api/types";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, ErrorNotice, inputClass, muted, td, th, trBorder } from "@/platform/components/ui";
import { formatDate } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { Fragment, useState } from "react";

const PAGE = 50;

function Code({ children }: { children: string }) {
  return <CodeBlock wrap code={children} />;
}

function Details({ event }: { event: AuditEvent }) {
  return (
    <div className="grid grid-cols-1 gap-4 bg-gray-50/60 px-5 py-4 md:grid-cols-2 dark:bg-white/2">
      <div>
        <p className={`mb-1 text-xs ${muted}`}>Resource</p>
        <Code>{`${event.resourceType} ${event.resourceId}`}</Code>
      </div>
      <div>
        <p className={`mb-1 text-xs ${muted}`}>Request</p>
        <Code>{`${event.requestId ?? "—"}${event.ipAddress ? ` from ${event.ipAddress}` : ""}`}</Code>
      </div>
      {event.before != null && (
        <div>
          <p className={`mb-1 text-xs ${muted}`}>Before</p>
          <Code>{JSON.stringify(event.before, null, 2)}</Code>
        </div>
      )}
      {event.after != null && (
        <div>
          <p className={`mb-1 text-xs ${muted}`}>After</p>
          <Code>{JSON.stringify(event.after, null, 2)}</Code>
        </div>
      )}
    </div>
  );
}

function Audit({ organization }: { organization: Organization }) {
  const [pages, setPages] = useState<AuditEvent[][]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const query = useAuditEvents(organization.id, PAGE, cursor);
  const forbidden = isForbidden(query.error);

  // The first page is live (it follows the refresh interval); older pages are frozen once loaded.
  const current = query.data ?? [];
  const events = cursor ? [...pages.flat(), ...current] : current;
  const needle = filter.trim().toLowerCase();
  const visible = needle ? events.filter((e) => `${e.action} ${e.actorLabel ?? ""} ${e.resourceType} ${e.reason ?? ""}`.toLowerCase().includes(needle)) : events;

  const loadMore = () => {
    if (current.length < PAGE) return;
    setPages(cursor ? [...pages, current] : [current]);
    setCursor(current[current.length - 1]!.createdAt);
  };

  return (
    <Card title="Audit trail" flush actions={<input className={`${inputClass} w-72`} placeholder="Filter by action, actor, resource" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />}>
      {forbidden ? (
        <EmptyState title="Not visible with your role">The audit trail is available to organization administrators, security administrators, compliance officers and auditors.</EmptyState>
      ) : query.error ? (
        <div className="p-4">
          <ErrorNotice error={query.error} />
        </div>
      ) : events.length === 0 ? (
        <EmptyState title="Nothing recorded yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800">
              <tr>
                <th className={th}>When</th>
                <th className={th}>Actor</th>
                <th className={th}>Action</th>
                <th className={th}>Resource</th>
                <th className={th}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <Fragment key={e.id}>
                  <tr className={`${trBorder} cursor-pointer hover:bg-gray-50 dark:hover:bg-white/2`} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className={`${td} ${muted} whitespace-nowrap`}>{formatDate(e.createdAt)}</td>
                    <td className={td}>
                      {e.actorType === "USER" ? (
                        e.actorLabel
                      ) : (
                        <Badge size="sm" color="light">
                          {e.actorType.toLowerCase()}
                        </Badge>
                      )}
                    </td>
                    <td className={`${td} font-medium text-gray-800 dark:text-white/90`}>{e.action}</td>
                    <td className={`${td} ${muted}`}>{e.resourceType}</td>
                    <td className={`${td} ${muted}`}>{e.reason ?? ""}</td>
                  </tr>
                  {open === e.id && (
                    <tr className={trBorder}>
                      <td colSpan={5} className="p-0">
                        <Details event={e} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!forbidden && current.length === PAGE && (
        <div className="flex justify-center p-4">
          <button type="button" onClick={loadMore} disabled={query.isFetching} className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700">
            Load older events
          </button>
        </div>
      )}
    </Card>
  );
}

export default function AuditPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Audit trail · ${productName}`} description="Every recorded action" />
      <PageBreadcrumb pageTitle="Audit trail" />
      <OrganizationGate>{(organization) => <Audit key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
