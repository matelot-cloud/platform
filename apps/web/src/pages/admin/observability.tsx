import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useMe, useObservabilityStatus, useTestOtlp } from "@/platform/api/hooks";
import type { ObservabilityStatus } from "@/platform/api/types";
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

  const ev = s.events;
  const byComponent = Object.entries(ev.byComponent).sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c} ${n.audit} · ${n.security}`).join(" — ");
  const instances = s.components.instances;
  const missing = (["api", "worker"] as const).filter((c) => !instances.some((i) => i.component === c && i.state === "current"));
  const logsToTempo = !!s.logs.endpoint && /tempo/i.test(s.logs.endpoint);

  return (
    <>
      <PageMeta title={`Observability · ${productName}`} description="What this cell exports" />
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Metrics" value={<OnOff on={s.metrics.enabled} label={s.metrics.enabled ? `:${s.metrics.port}/metrics` : "off"} />} caption={<>last scrape of this api: <Seen iso={s.metrics.lastScrapeAt} never="never — no Prometheus is scraping" /></>} tone={s.metrics.enabled && s.metrics.lastScrapeAt ? "good" : "warn"} />
          <Kpi label="Traces" value={<OnOff on={s.tracing.enabled} label={s.tracing.enabled ? `OTLP ${s.tracing.protocol}` : "off"} />} caption={<>last span: <Seen iso={s.tracing.lastSpanAt} never={s.tracing.enabled ? "none yet" : "tracing off"} /></>} tone={!s.tracing.enabled ? "default" : s.tracing.exportFailures ? "bad" : "good"} />
          <Kpi label="Audit / security events" value={`${ev.total.audit} · ${ev.total.security}`} caption={<>{byComponent || "none yet"} (audit · security, since each process started) · {s.logs.enabled ? `OTLP ${s.logs.exporter}` : "stdout only"}</>} tone={s.logs.exportFailures ? "bad" : ev.total.security ? "warn" : "default"} />
          <Kpi label="Grafana" value={s.grafana ? <a className="text-brand-500 hover:underline" href={s.grafana.url} target="_blank" rel="noreferrer">Open Grafana ↗</a> : <span className={muted}>not linked</span>} caption={s.grafana ? s.grafana.url : "set observability.grafana.url (Helm) or MATELOT_GRAFANA_URL (Compose)"} />
        </div>

        <Card title="Components" description="One row per process (pod) that reported in the last 2 minutes. Only current ones are counted; a pod a rollout replaced, or one silent for 45 s, is listed with its age." flush>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className={trBorder}><th className={th}>Component</th><th className={th}>Pod</th><th className={th}>Version</th><th className={th}>Heartbeat</th><th className={th}>Last scrape</th><th className={th}>Last trace</th><th className={th}>Export</th><th className={th}>Events</th><th className={th}>Failures</th></tr></thead>
              <tbody>
                {instances.map((i) => (
                  <tr key={`${i.component}:${i.instance}`} className={`${trBorder} ${i.state === "current" ? "" : "opacity-60"}`}>
                    <td className={td}>{i.component}</td>
                    <td className={`${td} font-mono text-xs`}>{i.instance}{i.state !== "current" && <div className="mt-1"><Badge size="sm" color="light">{i.state === "superseded" ? "superseded — not counted" : "stale — not counted"}</Badge></div>}</td>
                    <td className={td}>{i.version ?? "—"}</td>
                    <td className={td}>{i.ageSeconds} s ago</td>
                    <td className={td}><Seen iso={i.metricsScrapedAt} /></td>
                    <td className={td}><Seen iso={i.lastSpanAt} never={i.tracing ? "none yet" : "—"} /></td>
                    <td className={td}>traces {i.tracing ?? "off"} · logs {i.logs ?? "stdout"}</td>
                    <td className={td}>{i.events.audit} audit · {i.events.security} security</td>
                    <td className={td}>{i.exportFailures.traces.count || i.exportFailures.logs.count ? <span className="text-error-500">traces {i.exportFailures.traces.count} · logs {i.exportFailures.logs.count}</span> : <span className={muted}>none</span>}</td>
                  </tr>
                ))}
                {missing.map((c) => (
                  <tr key={`missing-${c}`} className={trBorder}><td className={td}>{c}</td><td className={td} colSpan={8}><span className="text-warning-600">{c} has not reported in the last 45 seconds</span></td></tr>
                ))}
                <tr className={trBorder}>
                  <td className={td}>runners</td>
                  <td className={td}>{s.components.runners.online} online</td>
                  <td className={td}>—</td><td className={td}>—</td>
                  <td className={td}><Seen iso={s.components.runners.metricsScrapedAt} never={s.components.runners.online ? "never" : "no runner online"} />{s.components.runners.online > 0 && !s.components.runners.reporting && <div className={`text-xs ${muted}`}>runners older than 2.25 do not report their scrapes</div>}</td>
                  <td className={td}>—</td>
                  <td className={td}>traces {s.components.runners.online ? `${s.components.runners.tracing} of ${s.components.runners.online}` : "—"}</td>
                  <td className={td}>—</td><td className={td}>—</td>
                </tr>
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
              <dt className={muted}>Trace export</dt><dd><Failures enabled={s.tracing.enabled} count={s.tracing.exportFailures} last={s.tracing.lastExportError} at={s.tracing.lastExportErrorAt} /></dd>
              <dt className={muted}>Log export</dt><dd><Failures enabled={s.logs.enabled} count={s.logs.exportFailures} last={s.logs.lastExportError} at={s.logs.lastExportErrorAt} />
                {logsToTempo && s.logs.exportFailures > 0 && <div className={`mt-1 text-xs ${muted}`}>Tempo takes traces only: point OTLP at a collector that forwards logs to Loki (Alloy, the OpenTelemetry Collector), or turn OTLP logs off — the events stay on stdout.</div>}</dd>
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

/** One signal's export failures, summed over the current pods; the last one as one line. */
function Failures({ enabled, count, last, at }: { enabled: boolean; count: number; last: string | null; at: string | null }) {
  if (!enabled) return <span className={muted}>off</span>;
  if (!count) return <span className="text-success-600">no failures since start</span>;
  return <span className="text-error-500">{count} failure{count === 1 ? "" : "s"}{last ? ` — ${last}` : ""}{at && <span className={muted}> ({relativeTime(at)})</span>}</span>;
}

export type { ObservabilityStatus };
