/**
 * Prometheus / OpenMetrics text exposition of what the OpenTelemetry SDK collected, with trace exemplars.
 *
 * Why not @opentelemetry/exporter-prometheus: it renders no exemplars (the JS SDK collects none yet), and the format
 * is what Grafana and the alert rules depend on, so it is pinned here and in exposition.spec.ts: OTel names with dots
 * become underscores, the unit becomes a suffix (`s` → `_seconds`, `By` → `_bytes`), monotonic sums get `_total`,
 * histograms expose `_bucket{le}` cumulative counts + `_sum` + `_count`, gauges are plain. A scraper that accepts
 * OpenMetrics (Prometheus does) gets `# {trace_id="…",span_id="…"} <value> <timestamp>` after the bucket line the
 * sample fell into — Grafana's "jump from a slow p95 to the trace" — and `# EOF`; a plain-text client gets the
 * same series without exemplars.
 */
import type { Attributes } from '@opentelemetry/api';
import { DataPointType, type HistogramMetricData, type MetricData, type ResourceMetrics } from '@opentelemetry/sdk-metrics';

export interface Exemplar { traceId: string; spanId: string; value: number; timestampMs: number }
/** Exemplars per series: `lookup(metricName, attributes)` → one exemplar per bucket index (the last recorded). */
export type ExemplarLookup = (metricName: string, attributes: Attributes) => ReadonlyMap<number, Exemplar> | undefined;

const UNIT_SUFFIX: Record<string, string> = { s: 'seconds', ms: 'milliseconds', By: 'bytes', '1': '', '': '' };

/** `http.server.request.duration` + unit `s` → `http_server_request_duration_seconds`. */
export function prometheusName(otelName: string, unit: string | undefined, monotonicCounter = false): string {
  let name = otelName.replace(/[^a-zA-Z0-9_:]/g, '_');
  const suffix = unit === undefined ? '' : UNIT_SUFFIX[unit] ?? unit.replace(/[^a-zA-Z0-9_]/g, '_');
  if (suffix && !name.endsWith(`_${suffix}`)) name += `_${suffix}`;
  if (monotonicCounter && !name.endsWith('_total')) name += '_total';
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return name;
}

export function labelName(key: string): string {
  const name = key.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

function escapeValue(v: unknown): string {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** `{a="1",b="2"}` with the keys sorted, or an empty string. */
export function labels(attributes: Attributes, extra: Record<string, string> = {}): string {
  const pairs = [...Object.entries(attributes).map(([k, v]) => [labelName(k), escapeValue(v)] as const), ...Object.entries(extra).map(([k, v]) => [k, escapeValue(v)] as const)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.length ? `{${pairs.map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
}

function num(v: number): string {
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  if (Number.isNaN(v)) return 'NaN';
  return String(v);
}

function exemplarSuffix(e: Exemplar | undefined, openMetrics: boolean): string {
  if (!e || !openMetrics) return '';
  return ` # {trace_id="${e.traceId}",span_id="${e.spanId}"} ${num(e.value)} ${(e.timestampMs / 1000).toFixed(3)}`;
}

function histogram(out: string[], name: string, data: HistogramMetricData, exemplars: ExemplarLookup | undefined, openMetrics: boolean): void {
  for (const dp of data.dataPoints) {
    const { boundaries, counts } = dp.value.buckets;
    const ex = exemplars?.(data.descriptor.name, dp.attributes);
    let cumulative = 0;
    for (let i = 0; i < counts.length; i++) {
      cumulative += counts[i];
      const le = i < boundaries.length ? num(boundaries[i]) : '+Inf';
      out.push(`${name}_bucket${labels(dp.attributes, { le })} ${cumulative}${exemplarSuffix(ex?.get(i), openMetrics)}`);
    }
    out.push(`${name}_sum${labels(dp.attributes)} ${num(dp.value.sum ?? 0)}`);
    out.push(`${name}_count${labels(dp.attributes)} ${dp.value.count}`);
  }
}

export function serializeMetric(out: string[], metric: MetricData, exemplars: ExemplarLookup | undefined, openMetrics: boolean): void {
  const d = metric.descriptor;
  const help = d.description ? `# HELP %s ${escapeValue(d.description).replace(/\\"/g, '"')}` : null;
  switch (metric.dataPointType) {
    case DataPointType.SUM: {
      const monotonic = metric.isMonotonic;
      const name = prometheusName(d.name, d.unit, monotonic);
      if (help) out.push(help.replace('%s', name));
      out.push(`# TYPE ${name} ${monotonic ? 'counter' : 'gauge'}`);
      for (const dp of metric.dataPoints) out.push(`${name}${labels(dp.attributes)} ${num(dp.value)}`);
      return;
    }
    case DataPointType.GAUGE: {
      const name = prometheusName(d.name, d.unit);
      if (help) out.push(help.replace('%s', name));
      out.push(`# TYPE ${name} gauge`);
      for (const dp of metric.dataPoints) out.push(`${name}${labels(dp.attributes)} ${num(dp.value)}`);
      return;
    }
    case DataPointType.HISTOGRAM: {
      const name = prometheusName(d.name, d.unit);
      if (help) out.push(help.replace('%s', name));
      out.push(`# TYPE ${name} histogram`);
      histogram(out, name, metric as HistogramMetricData, exemplars, openMetrics);
      return;
    }
    default:
      return; // exponential histograms are not used
  }
}

/** A gauge family rendered from its owner's current series (GaugeSet): the SDK keeps cumulative series that stopped
 *  being observed, Prometheus semantics want them gone — a pool that vanished must not report its last runner count. */
export interface GaugeFamily { name: string; unit?: string; description?: string; series: { attributes: Attributes; value: number }[] }

/** A histogram's label sets published at zero until observed (the SDK omits what was never recorded). */
export interface HistogramSeeds { name: string; unit?: string; description?: string; boundaries: readonly number[]; seeds: Attributes[] }

function zeroHistogram(out: string[], name: string, boundaries: readonly number[], attributes: Attributes): void {
  for (const b of boundaries) out.push(`${name}_bucket${labels(attributes, { le: num(b) })} 0`);
  out.push(`${name}_bucket${labels(attributes, { le: '+Inf' })} 0`);
  out.push(`${name}_sum${labels(attributes)} 0`);
  out.push(`${name}_count${labels(attributes)} 0`);
}

/** The whole page; `openMetrics` adds exemplars and the `# EOF` trailer. */
export function serialize(resourceMetrics: ResourceMetrics, exemplars?: ExemplarLookup, openMetrics = false, gauges: GaugeFamily[] = [], seeded: HistogramSeeds[] = []): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const seedsByName = new Map(seeded.map((s) => [s.name, s]));
  const seriesKey = (a: Attributes) => JSON.stringify(Object.entries(a).sort());
  for (const g of gauges) {
    const name = prometheusName(g.name, g.unit);
    seen.add(name);
    if (g.description) out.push(`# HELP ${name} ${escapeValue(g.description).replace(/\\"/g, '"')}`);
    out.push(`# TYPE ${name} gauge`);
    for (const s of g.series) out.push(`${name}${labels(s.attributes)} ${num(s.value)}`);
  }
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const key = prometheusName(metric.descriptor.name, metric.descriptor.unit, metric.dataPointType === DataPointType.SUM && metric.isMonotonic);
      if (seen.has(key)) continue; // two instruments rendering the same family would be an invalid page: first wins
      seen.add(key);
      serializeMetric(out, metric, exemplars, openMetrics);
      const sd = metric.dataPointType === DataPointType.HISTOGRAM ? seedsByName.get(metric.descriptor.name) : undefined;
      if (sd) {   // seeded sets not yet observed, after the real series of the same family
        const have = new Set(metric.dataPoints.map((dp) => seriesKey(dp.attributes)));
        for (const a of sd.seeds) if (!have.has(seriesKey(a))) zeroHistogram(out, key, sd.boundaries, a);
      }
    }
  }
  for (const sd of seeded) {   // histograms nothing has observed yet: the whole family at zero
    const name = prometheusName(sd.name, sd.unit);
    if (seen.has(name)) continue;
    seen.add(name);
    if (sd.description) out.push(`# HELP ${name} ${escapeValue(sd.description).replace(/\\"/g, '"')}`);
    out.push(`# TYPE ${name} histogram`);
    for (const a of sd.seeds) zeroHistogram(out, name, sd.boundaries, a);
  }
  if (openMetrics) out.push('# EOF');
  return out.join('\n') + '\n';
}

export const OPENMETRICS_CONTENT_TYPE = 'application/openmetrics-text; version=1.0.0; charset=utf-8';
export const TEXT_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Prometheus sends `Accept: application/openmetrics-text;version=1.0.0,…`; anything else gets the plain format. */
export function wantsOpenMetrics(accept: string | undefined): boolean {
  return (accept ?? '').toLowerCase().includes('application/openmetrics-text');
}
