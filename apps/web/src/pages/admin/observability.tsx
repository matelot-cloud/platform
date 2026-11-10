import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useMe, useObservabilityStatus, useTestOtlp } from "@/platform/api/hooks";
import type { ObservabilityComponent, ObservabilityStatus } from "@/platform/api/types";
import { Kpi } from "@/platform/components/Dashboard";
import { Card, codeBlock, EmptyState, ErrorNotice, muted, Note, outlineButton, primaryButton, td, th, trBorder } from "@/platform/components/ui";
import { formatDate, relativeTime } from "@/platform/format";
import { docsUrl, useRuntimeConfig } from "@/platform/runtime-config";

const STALE_MS = 5 * 60_000;

/** "2 minutes ago" with a tone: fresh (< 5 min), stale, never. */
function Seen({ iso, never = "never" }: { iso: string | null | undefined; never?: string }) {
  if (!iso) return <span className={muted}>{never}</span>;
  const stale = Date.now() - new Date(iso).getTime() > STALE_MS;
  return <span className={stale ? "text-warning-600" : "text-success-600"} title={formatDate(iso)}>{relativeTime(iso)}</span>;
}

function OnOff({ on, label }: { on: boolean; label?: string }) {
  return <Badge size="sm" color={on ? "success" : "light"}>{label ?? (on ? "on" : "off")}</Badge>;
}

/**
 * Administration → Observability (cell administrators): what this cell exports — the metrics pages, OTLP traces and
 * the audit / security event records — and whether anything is listening: last scrape per component, last trace
 * seen, export failures, the OTLP endpoint with its headers masked, a "Test OTLP" button and the link to Grafana.
 * Read-only: the settings themselves live in the chart values / Compose .env (docs/observability.md).
 */
export default function AdminObservabilityPage() {
  const { productName, ...config } = useRuntimeConfig();
  const docs = `${docsUrl(config)}/latest/observability.html`;
  const me = useMe();
  const status = useObservabilityStatus(!!me.data);
  const test = useTestOtlp();
  const s = status.data;

  if (status.error && isForbidden(status.error)) {
    return <EmptyState title="Observability settings are for cell administrators">Ask a cell administrator to open this page, or to make you one under Administration → Users.</EmptyState>;
  }
  if (status.error) return <ErrorNotice error={status.error} />;
  if (!s) return <p className={muted}>Loading…</p>;

  const components: { name: string; version: string | null; scraped: string | null; traced: string | null; tracing: string | null; events: string; note?: string }[] = [
    row("api", s.components.api), row("worker", s.components.worker),
    { name: `runners (${s.components.runners.online} online)`, version: null, scraped: s.components.runners.metricsScrapedAt, traced: null, tracing: s.components.runners.online ? `${s.components.runners.tracing} of ${s.components.runners.online}` : null, events: "—", note: s.components.runners.online && !s.components.runners.reporting ? "runners older than 2.25 do not report their scrapes" : undefined },
  ];

  return (
    <>
      <PageMeta title={`Observability · ${productName}`} description="What this cell exports" />
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Metrics" value={<OnOff on={s.metrics.enabled} label={s.metrics.enabled ? `:${s.metrics.port}/metrics` : "off"} />} caption={<>last scrape of this api: <Seen iso={s.metrics.lastScrapeAt} never="never — no Prometheus is scraping" /></>} tone={s.metrics.enabled && s.metrics.lastScrapeAt ? "good" : "warn"} />
          <Kpi label="Traces" value={<OnOff on={s.tracing.enabled} label={s.tracing.enabled ? `OTLP ${s.tracing.protocol}` : "off"} />} caption={<>last span: <Seen iso={s.tracing.lastSpanAt} never={s.tracing.enabled ? "none yet" : "tracing off"} /></>} tone={!s.tracing.enabled ? "default" : s.tracing.exportFailures ? "bad" : "good"} />
          <Kpi label="Event records" value={<OnOff on={s.logs.enabled} label={s.logs.enabled ? `OTLP ${s.logs.exporter}` : "stdout only"} />} caption={`${s.logs.emitted.audit} audit · ${s.logs.emitted.security} security since start`} tone={s.logs.emitted.security ? "warn" : "default"} />
          <Kpi label="Grafana" value={s.grafana ? <a className="text-brand-500 hover:underline" href={s.grafana.url} target="_blank" rel="noreferrer">Open Grafana ↗</a> : <span className={muted}>not linked</span>} caption={s.grafana ? s.grafana.url : "set observability.grafana.url (Helm) or MATELOT_GRAFANA_URL (Compose)"} />
        </div>

        <Card title="Components" description="Each component's last metrics scrape and last trace; a scrape older than 5 minutes means no Prometheus is reaching it." flush>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className={trBorder}><th className={th}>Component</th><th className={th}>Version</th><th className={th}>Last scrape</th><th className={th}>Last trace</th><th className={th}>Tracing</th><th className={th}>Events emitted</th></tr></thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.name} className={trBorder}>
                    <td className={td}>{c.name}{c.note && <div className={`text-xs ${muted}`}>{c.note}</div>}</td>
                    <td className={td}>{c.version ?? "—"}</td>
                    <td className={td}><Seen iso={c.scraped} never={c.name.startsWith("runners") && !s.components.runners.online ? "no runner online" : "never"} /></td>
                    <td className={td}><Seen iso={c.traced} never={c.tracing ? "none yet" : "—"} /></td>
                    <td className={td}>{c.tracing ?? <span className={muted}>off</span>}</td>
                    <td className={td}>{c.events}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="OTLP export" description="Where traces and event records go. Header values are never shown; they come from a Secret (Helm) or .env (Compose)." actions={
            <button type="button" className={primaryButton} disabled={test.isPending || (!s.tracing.enabled && !s.logs.enabled)} onClick={() => test.mutate()}>{test.isPending ? "Sending…" : "Test OTLP"}</button>
          }>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className={muted}>Traces endpoint</dt><dd className="font-mono text-xs break-all">{s.tracing.endpoint ?? <span className={muted}>not configured</span>}</dd>
              <dt className={muted}>Logs endpoint</dt><dd className="font-mono text-xs break-all">{s.logs.endpoint ?? <span className={muted}>not configured (OTEL_LOGS_EXPORTER unset)</span>}</dd>
              <dt className={muted}>Headers</dt><dd className="font-mono text-xs">{s.tracing.headers.length ? s.tracing.headers.join(", ") : <span className={muted}>none</span>}</dd>
              <dt className={muted}>Sampler</dt><dd>{s.tracing.sampler} · GET ratio {s.tracing.getRatio}</dd>
              <dt className={muted}>Export failures</dt><dd>{s.tracing.exportFailures ? <span className="text-error-500">{s.tracing.exportFailures}{s.tracing.lastExportError ? ` — ${s.tracing.lastExportError}` : ""}</span> : <span className="text-success-600">none since start</span>}</dd>
            </dl>
            {test.error && <div className="mt-4"><ErrorNotice error={test.error} /></div>}
            {test.data && (
              <Note className="mt-4">
                <div className="space-y-1 text-sm">
                  <div>Traces: {test.data.traces.attempted ? (test.data.traces.ok ? <span className="text-success-600">sent (trace id {test.data.traceId}) — look for a span named <code>matelot.test</code></span> : <span className="text-error-500">export failed — {test.data.traces.error}</span>) : <span className={muted}>{test.data.traces.error}</span>}</div>
                  <div>Event records: {test.data.logs.attempted ? (test.data.logs.ok ? <span className="text-success-600">sent — look for <code>event.name = matelot.test</code></span> : <span className="text-error-500">export failed — {test.data.logs.error}</span>) : <span className={muted}>{test.data.logs.error}</span>}</div>
                </div>
              </Note>
            )}
          </Card>

          <Card title="Check from a terminal" description="The same checks as this page, from outside the cell.">
            <pre className={codeBlock}>{`matelot doctor            # includes an Observability section\nmatelot doctor --json     # …as JSON, for a monitoring script`}</pre>
            <p className={`mt-4 text-sm ${muted}`}>
              Cell <b>{s.cell ?? "—"}</b> · environment <b>{s.environment}</b> · refreshed {relativeTime(s.generatedAt)}.
              Dashboards, alert rules and the event schema for your SIEM: <a className="text-brand-500 hover:underline" href={docs} target="_blank" rel="noreferrer">observability documentation ↗</a>.
            </p>
            <div className="mt-4"><a className={outlineButton} href={`${docs}#audit-and-security-events`} target="_blank" rel="noreferrer">Event schema</a></div>
          </Card>
        </div>
      </div>
    </>
  );
}

function row(name: string, c: ObservabilityComponent | null) {
  return { name, version: c?.version ?? null, scraped: c?.metricsScrapedAt ?? null, traced: c?.lastSpanAt ?? null, tracing: c?.tracing ?? null, events: c ? `${c.events.audit} audit · ${c.events.security} security` : "—", note: c ? undefined : `${name} has not reported in the last 2 minutes` };
}

export type { ObservabilityStatus };
