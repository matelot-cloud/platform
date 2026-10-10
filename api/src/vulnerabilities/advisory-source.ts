import { Injectable, Logger } from '@nestjs/common';
import type { OsvPackageQuery } from './osv-mapping';

export interface OsvVulnerability {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  published?: string;
  modified?: string;
  severity?: { type: string; score: string }[];
  affected?: unknown[];
  references?: { type: string; url: string }[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
}

/** External advisory data: OSV (vulnerabilities per package), CISA KEV (exploited), FIRST EPSS (exploit probability). */
export interface AdvisorySource {
  /** For each query, the ids of vulnerabilities affecting that package version (same order as input). */
  queryBatch(queries: OsvPackageQuery[]): Promise<string[][]>;
  vulnerability(id: string): Promise<OsvVulnerability | null>;
  kev(): Promise<Map<string, { dueDate: string | null }>>;
  epss(cves: string[]): Promise<Map<string, { score: number; percentile: number }>>;
  /** CVSS of a CVE from NVD (v3.1, else v3.0, else v4.0 base score), used when OSV has no rating at all. Optional. */
  nvdCvss?(cve: string): Promise<{ score: number; vector: string; description: string | null } | null>;
}

// Overridable for tests / air-gapped mirrors.
const OSV = process.env.OSV_API_URL ?? 'https://api.osv.dev/v1';
const KEV = process.env.KEV_FEED_URL ?? 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const EPSS = process.env.EPSS_API_URL ?? 'https://api.first.org/data/v1/epss';
// NVD API 2.0; set NVD_API_URL='' to disable (air-gapped). NVD_API_KEY raises the rate limit (5 → 50 requests / 30 s).
/** Every upstream call is bounded: a hanging OSV/NVD/EPSS/KEV never blocks correlation. */
export const FETCH_TIMEOUT_MS = Number(process.env.ADVISORY_FETCH_TIMEOUT_MS ?? 15_000);
const NVD = process.env.NVD_API_URL ?? 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const NVD_KEY = process.env.NVD_API_KEY;

@Injectable()
export class HttpAdvisorySource implements AdvisorySource {
  private readonly logger = new Logger(HttpAdvisorySource.name);

  async queryBatch(queries: OsvPackageQuery[]): Promise<string[][]> {
    const out: string[][] = [];
    for (let i = 0; i < queries.length; i += 500) {
      const chunk = queries.slice(i, i + 500);
      const response = await fetch(`${OSV}/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`OSV querybatch failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
      const data = (await response.json()) as { results: { vulns?: { id: string }[] }[] };
      for (const r of data.results) out.push((r.vulns ?? []).map((v) => v.id));
    }
    return out;
  }

  async vulnerability(id: string): Promise<OsvVulnerability | null> {
    const response = await fetch(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OSV vulns/${id} failed: ${response.status}`);
    return (await response.json()) as OsvVulnerability;
  }

  private nvdNext = 0;
  async nvdCvss(cve: string): Promise<{ score: number; vector: string; description: string | null } | null> {
    if (!NVD) return null;
    const wait = this.nvdNext - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.nvdNext = Date.now() + (NVD_KEY ? 700 : 6500);
    const response = await fetch(`${NVD}?cveId=${encodeURIComponent(cve)}`, { headers: NVD_KEY ? { apiKey: NVD_KEY } : {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) { this.logger.warn(`NVD ${cve}: ${response.status}`); return null; }
    const data = (await response.json()) as { vulnerabilities?: { cve: { descriptions?: { lang: string; value: string }[]; metrics?: Record<string, { type?: string; cvssData: { baseScore: number; vectorString: string } }[]> } }[] };
    const c = data.vulnerabilities?.[0]?.cve;
    if (!c) return null;
    for (const key of ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV40']) {
      const list = c.metrics?.[key] ?? [];
      const m = list.find((x) => x.type === 'Primary') ?? list[0];
      if (m) return { score: m.cvssData.baseScore, vector: m.cvssData.vectorString, description: c.descriptions?.find((d) => d.lang === 'en')?.value ?? null };
    }
    return null;
  }

  async kev(): Promise<Map<string, { dueDate: string | null }>> {
    const response = await fetch(KEV, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`KEV feed failed: ${response.status}`);
    const data = (await response.json()) as { vulnerabilities: { cveID: string; dueDate?: string }[] };
    return new Map(data.vulnerabilities.map((v) => [v.cveID.toUpperCase(), { dueDate: v.dueDate ?? null }]));
  }

  async epss(cves: string[]): Promise<Map<string, { score: number; percentile: number }>> {
    const out = new Map<string, { score: number; percentile: number }>();
    for (let i = 0; i < cves.length; i += 100) {
      const chunk = cves.slice(i, i + 100);
      const response = await fetch(`${EPSS}?cve=${chunk.join(',')}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        this.logger.warn(`EPSS failed: ${response.status}`);
        continue;
      }
      const data = (await response.json()) as { data: { cve: string; epss: string; percentile: string }[] };
      for (const d of data.data) out.set(d.cve.toUpperCase(), { score: Number(d.epss), percentile: Number(d.percentile) });
    }
    return out;
  }
}

export const ADVISORY_SOURCE = Symbol('ADVISORY_SOURCE');
