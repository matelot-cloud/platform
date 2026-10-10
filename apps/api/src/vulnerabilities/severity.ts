import { parsePurl } from '../sbom/parse';
import { cvss3BaseScore, osvQueryFor, severityFromScore } from './osv-mapping';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
/** Where a severity came from. `alias` = CVSS of an alias record (CVE/GHSA), only when the record has no rating at all. */
export type SeveritySource = 'distro' | 'cvss' | 'database' | 'alias' | 'unknown';

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

interface AffectedEntry { package?: { ecosystem?: string; name?: string }; ranges?: { events?: Record<string, string>[] }[]; ecosystem_specific?: Record<string, unknown> | null }

/**
 * One reader per distribution family: OSV `affected` entry → (severity, raw label) or null.
 * Ubuntu / Alpine / RHEL are added here; nothing else changes.
 */
const DISTRO_READERS: { family: string; label: string; read: (e: AffectedEntry) => { severity: Severity; raw: string } | null }[] = [
  {
    family: 'Debian',
    label: 'Debian',
    read: (e) => {
      // Debian security-tracker urgency; a trailing "*" marks an inferred value ("low*", "low**").
      const raw = String(e.ecosystem_specific?.urgency ?? '').trim().replace(/\*+$/, '').toLowerCase();
      const map: Record<string, Severity> = { unimportant: 'low', 'end-of-life': 'low', low: 'low', medium: 'medium', high: 'high' };
      return map[raw] ? { severity: map[raw]!, raw } : null; // "not yet assigned" / unknown → no rating
    },
  },
];

export interface DistroRating { severity: Severity; label: string; suite: string | null; noFixPlanned: boolean }

/**
 * The distribution's rating of an advisory. With `suite` (e.g. "Debian:13" from the component) the matching suite's
 * entry wins; otherwise (or when that suite is not listed) the most severe value across suites.
 */
export function distroRating(affected: unknown[] | null | undefined, opts: { suite?: string | null; packageName?: string | null } = {}): DistroRating | null {
  const entries = ((affected ?? []) as AffectedEntry[]).filter((e) => !opts.packageName || !e.package?.name || e.package.name === opts.packageName);
  for (const reader of DISTRO_READERS) {
    const rated = entries
      .filter((e) => (e.package?.ecosystem ?? '').startsWith(reader.family))
      .map((e) => ({ e, r: reader.read(e) }))
      .filter((x): x is { e: AffectedEntry; r: { severity: Severity; raw: string } } => !!x.r);
    if (!rated.length) continue;
    const exact = opts.suite ? rated.find((x) => x.e.package?.ecosystem === opts.suite) : undefined;
    const pick = exact ?? rated.reduce((a, b) => (RANK[b.r.severity] > RANK[a.r.severity] ? b : a));
    const noFixPlanned = pick.r.raw === 'unimportant' && !pick.e.ranges?.some((r) => r.events?.some((ev) => 'fixed' in ev));
    return { severity: pick.r.severity, label: `${reader.label}: ${pick.r.raw}`, suite: pick.e.package?.ecosystem ?? null, noFixPlanned };
  }
  return null;
}

export interface AdvisoryForSeverity {
  id: string;
  summary?: string | null;
  details?: string | null;
  /** The record's own CVSS (kept and displayed even when it does not decide). */
  cvssVector?: string | null;
  cvssScore?: number | null;
  /** database_specific.severity, raw text. */
  databaseSeverity?: string | null;
  affected?: unknown[] | null;
  aliasCvssScore?: number | null;
  aliasText?: string | null;
}

export interface SeverityDecision {
  severity: Severity;
  source: SeveritySource;
  /** Shown next to the severity: "Debian: unimportant · disputed · no fix planned". */
  note: string | null;
  disputed: boolean;
  noFixPlanned: boolean;
}

const DB_TEXT: Record<string, Severity> = { critical: 'critical', high: 'high', important: 'high', moderate: 'medium', medium: 'medium', low: 'low' };

/**
 * Order: distribution rating → CVSS vector → database_specific.severity → alias CVSS → unknown.
 * Without `purl`: the advisory-level severity (most severe distro suite). With an OS-package purl: the component's own
 * suite decides (Debian:13 from `distro=debian-13.x`, or from a `+deb13uN` version when the distro is missing).
 * Distribution ratings apply to OS packages only; a language package never takes a Debian urgency.
 */
export function decideSeverity(a: AdvisoryForSeverity, purl?: string | null): SeverityDecision {
  const disputed = /\bDISPUTED\b/.test(`${a.summary ?? ''}\n${a.details ?? ''}\n${a.aliasText ?? ''}`);
  const q = purl ? osvQueryFor(purl) : null;
  const ptype = purl ? parsePurl(purl).type : null;
  let suite: string | null = q && /^(Debian|Ubuntu)/.test(q.ecosystem) && q.ecosystem.includes(':') ? q.ecosystem : null;
  if (!suite && ptype === 'deb' && purl) { const m = /deb(\d+)u\d+/.exec(decodeURIComponent(purl)); if (m) suite = `Debian:${m[1]}`; }
  let triage: string[] = [];
  const tail = (extra: string[]) => { const n = [...extra, ...triage, ...(disputed ? ['disputed'] : [])]; return n.length ? n.join(' · ') : null; };
  if (!ptype || ['deb', 'rpm', 'apk'].includes(ptype)) {
    const d = distroRating(a.affected, { suite, packageName: q?.name ?? null });
    if (d) return { severity: d.severity, source: 'distro', note: tail([d.label]) + (d.noFixPlanned ? ' · no fix planned' : ''), disputed, noFixPlanned: d.noFixPlanned };
  }
  // Debian has the advisory but has not triaged it for this suite ("not yet assigned" / tracker status "undetermined"):
  // say so, because scanners that follow the Debian tracker (Grype) skip such entries.
  const untriaged = ((a.affected ?? []) as AffectedEntry[]).some((e) => (e.package?.ecosystem ?? '').startsWith('Debian') && (!suite || e.package?.ecosystem === suite) && String(e.ecosystem_specific?.urgency ?? '').trim().toLowerCase() === 'not yet assigned');
  if (untriaged && (ptype === 'deb' || ptype === null)) triage = ['Debian: not yet triaged'];
  const score = a.cvssScore ?? (a.cvssVector ? cvss3BaseScore(a.cvssVector) : null);
  if (score !== null && score !== undefined) return { severity: severityFromScore(score), source: 'cvss', note: tail([]), disputed, noFixPlanned: false };
  const db = DB_TEXT[(a.databaseSeverity ?? '').toLowerCase()];
  if (db) return { severity: db, source: 'database', note: tail([]), disputed, noFixPlanned: false };
  if (a.aliasCvssScore !== null && a.aliasCvssScore !== undefined) return { severity: severityFromScore(a.aliasCvssScore), source: 'alias', note: tail([]), disputed, noFixPlanned: false };
  return { severity: 'unknown', source: 'unknown', note: tail([]), disputed, noFixPlanned: false };
}

/** Key for "one advisory per source package": libc6 and libc-bin are both Debian/glibc. */
export function packageKeyOf(purl: string): string {
  const q = osvQueryFor(purl);
  if (q) return `${q.ecosystem.split(':')[0]}/${q.name}`;
  const p = parsePurl(purl);
  return `${p.type}/${p.namespace ? `${p.namespace}/` : ''}${p.name}`;
}

/**
 * Per-component findings collapsed to unique (advisory, source package), keeping the highest severity.
 * Gate and CRA readiness use it; the SQL counts in findings.service use the same key.
 */
export function uniqueVulnerabilities<T extends { advisoryId: string; canonicalId?: string | null; packageKey: string | null; componentId: string; severity: Severity }>(rows: T[]): { unique: T[]; packages: number } {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.canonicalId ?? r.advisoryId}|${r.packageKey ?? r.componentId}`;
    const cur = m.get(k);
    if (!cur || RANK[r.severity] > RANK[cur.severity]) m.set(k, r);
  }
  return { unique: [...m.values()], packages: rows.length };
}

/** The CVE a record is about (lowest CVE alias; a DEBIAN-CVE-x id is CVE-x), else the record id. */
export function canonicalAdvisoryId(id: string, aliases: string[] | null | undefined, upstream?: string[] | null): string {
  const cves = [...(aliases ?? []), ...(upstream ?? [])].filter((a) => /^CVE-\d{4}-\d+$/i.test(a)).map((a) => a.toUpperCase()).sort();
  if (cves.length) return cves[0]!;
  const m = /^(?:DEBIAN-)?(CVE-\d{4}-\d+)$/i.exec(id);
  return m ? m[1]!.toUpperCase() : id;
}
