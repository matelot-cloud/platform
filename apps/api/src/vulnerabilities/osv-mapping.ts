/**
 * Mapping between package URLs (as found in SBOMs) and OSV ecosystems, plus version utilities
 * used to compute the first fixed version for a finding.
 */
import { parsePurl } from '../sbom/parse';

export interface OsvPackageQuery {
  ecosystem: string;
  name: string;
  version: string;
}

const TYPE_TO_ECOSYSTEM: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  maven: 'Maven',
  golang: 'Go',
  cargo: 'crates.io',
  nuget: 'NuGet',
  gem: 'RubyGems',
  composer: 'Packagist',
  hex: 'Hex',
  pub: 'Pub',
  swift: 'SwiftURL',
  cocoapods: 'CocoaPods',
  hackage: 'Hackage',
  cran: 'CRAN',
  github: 'GitHub Actions',
};

function qualifiers(purl: string): Record<string, string> {
  const q = purl.split('?')[1]?.split('#')[0];
  if (!q) return {};
  return Object.fromEntries(q.split('&').map((kv) => kv.split('=').map((x) => decodeURIComponent(x)) as [string, string]));
}

/** OSV query for a purl, or null when the ecosystem is not covered (files, generic, unknown distros). */
export function osvQueryFor(purl: string): OsvPackageQuery | null {
  const p = parsePurl(purl);
  if (!p.version) return null;
  const q = qualifiers(purl);
  const name = p.namespace ? (p.type === 'maven' ? `${p.namespace}:${p.name}` : `${p.namespace}/${p.name}`) : p.name;
  switch (p.type) {
    case 'deb': {
      // pkg:deb/debian/libc6@2.41-12+deb13u4?distro=debian-13.7&upstream=glibc → Debian:13 / glibc
      // OSV (like the Debian security tracker) keys advisories by SOURCE package: query the source name, and the
      // source version when the purl carries one (upstream=zlib@1:1.3.dfsg+really1.3.1-1; binNMUs add +bN to the binary).
      // Debian ecosystems are major-only in OSV (Debian:13, not Debian:13.7); Ubuntu keeps the release (Ubuntu:22.04).
      const [srcName, ...srcVer] = (q.upstream ?? '').split('@');
      const pkgName = srcName || p.name;
      const pkgVersion = srcVer.length ? srcVer.join('@') : p.version;
      const distro = q.distro ?? '';
      const m = /^(debian|ubuntu)-([\w.]+)/i.exec(distro);
      if (!m) return p.namespace === 'debian' ? { ecosystem: 'Debian', name: pkgName, version: pkgVersion } : null;
      const family = m[1]!.toLowerCase();
      const release = family === 'debian' ? m[2]!.split('.')[0]! : m[2]!;
      return { ecosystem: `${family === 'debian' ? 'Debian' : 'Ubuntu'}:${release}`, name: pkgName, version: pkgVersion };
    }
    case 'apk': {
      // pkg:apk/alpine/openssl@3.3.2-r0?arch=x86_64&distro=alpine-3.20.3 → Alpine:v3.20
      const m = /alpine-(\d+\.\d+)/i.exec(q.distro ?? '');
      return m ? { ecosystem: `Alpine:v${m[1]}`, name: p.name, version: p.version } : null;
    }
    case 'rpm': {
      const distro = (q.distro ?? '').toLowerCase();
      if (distro.startsWith('rhel') || distro.startsWith('redhat')) return { ecosystem: 'Red Hat', name: p.name, version: p.version };
      if (distro.startsWith('almalinux')) return { ecosystem: `AlmaLinux:${distro.split('-')[1]?.split('.')[0] ?? ''}`.replace(/:$/, ''), name: p.name, version: p.version };
      if (distro.startsWith('rocky')) return { ecosystem: `Rocky Linux:${distro.split('-')[1]?.split('.')[0] ?? ''}`.replace(/:$/, ''), name: p.name, version: p.version };
      return null;
    }
    default: {
      const eco = TYPE_TO_ECOSYSTEM[p.type];
      return eco ? { ecosystem: eco, name, version: p.version } : null;
    }
  }
}

/** Loose version comparison: numeric segments compare numerically, then strings; enough for "first fixed after X". */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v(?=\d)/, '').split(/[.\-+~:_]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return typeof y === 'string' ? 1 : -1; // 1.0 > 1.0-rc1 ; 1.0 < 1.0.1
    if (y === undefined) return typeof x === 'string' ? -1 : 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (typeof x !== typeof y) return typeof x === 'number' ? 1 : -1;
    else if (x !== y) return String(x).localeCompare(String(y));
  }
  return 0;
}

interface OsvAffected {
  package?: { ecosystem?: string; name?: string; purl?: string };
  ranges?: { type: string; events: { introduced?: string; fixed?: string; last_affected?: string }[] }[];
  versions?: string[];
}

/** First "fixed" event of the range that contains `version` for the matching package; null when unknown/unfixed. */
export function fixedVersionFor(affected: unknown[], ecosystem: string, name: string, version: string): string | null {
  for (const a of affected as OsvAffected[]) {
    if (!a.package?.name || a.package.name.toLowerCase() !== name.toLowerCase()) continue;
    if (a.package.ecosystem && a.package.ecosystem.split(':')[0].toLowerCase() !== ecosystem.split(':')[0].toLowerCase()) continue;
    for (const range of a.ranges ?? []) {
      if (range.type === 'GIT') continue;
      let introduced: string | null = null;
      for (const ev of range.events) {
        if (ev.introduced !== undefined) introduced = ev.introduced === '0' ? '0' : ev.introduced;
        if (ev.fixed !== undefined && introduced !== null) {
          const inRange = (introduced === '0' || compareVersions(version, introduced) >= 0) && compareVersions(version, ev.fixed) < 0;
          if (inRange) return ev.fixed;
          introduced = null;
        }
      }
    }
  }
  return null;
}

/** CVSS v3.x base score from a vector string (returns null for unknown formats). */
export function cvss3BaseScore(vector: string): number | null {
  const m = /CVSS:3\.[01]\/(.+)/.exec(vector);
  if (!m) return null;
  const v = Object.fromEntries(m[1].split('/').map((kv) => kv.split(':') as [string, string]));
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[v.AV as string];
  const AC = { L: 0.77, H: 0.44 }[v.AC as string];
  const UI = { N: 0.85, R: 0.62 }[v.UI as string];
  const S = v.S;
  const PR = S === 'C' ? { N: 0.85, L: 0.68, H: 0.5 }[v.PR as string] : { N: 0.85, L: 0.62, H: 0.27 }[v.PR as string];
  const cia = { H: 0.56, L: 0.22, N: 0 };
  const C = cia[v.C as keyof typeof cia];
  const I = cia[v.I as keyof typeof cia];
  const A = cia[v.A as keyof typeof cia];
  if ([AV, AC, UI, PR, C, I, A].some((x) => x === undefined) || !S) return null;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = S === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;
  if (impact <= 0) return 0;
  const roundUp = (x: number) => Math.ceil(x * 10 - 1e-9) / 10;
  return S === 'U' ? roundUp(Math.min(impact + exploitability, 10)) : roundUp(Math.min(1.08 * (impact + exploitability), 10));
}

export function severityFromScore(score: number | null | undefined): 'critical' | 'high' | 'medium' | 'low' | 'unknown' {
  if (score === null || score === undefined) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}
