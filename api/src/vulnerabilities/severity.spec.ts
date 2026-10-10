import { cvss3BaseScore } from './osv-mapping';
import { canonicalAdvisoryId, decideSeverity, distroRating, packageKeyOf, uniqueVulnerabilities } from './severity';

const NVD_VECTOR = 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const suite = (ecosystem: string, urgency: string, fixed?: string) => ({ package: { ecosystem, name: 'glibc' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, ...(fixed ? [{ fixed }] : [])] }], ecosystem_specific: { urgency } });
/** DEBIAN-CVE-2019-1010022 as returned by api.osv.dev: NVD's vector in `severity`, database_specific null, urgency on every suite. */
const REAL = {
  id: 'DEBIAN-CVE-2019-1010022',
  summary: null,
  details: '** DISPUTED ** GNU Libc current is affected by: Mitigation bypass. The upstream maintainer disputes this.',
  cvssVector: NVD_VECTOR,
  cvssScore: cvss3BaseScore(NVD_VECTOR),
  databaseSeverity: null,
  affected: [suite('Debian:11', 'unimportant'), suite('Debian:12', 'unimportant'), suite('Debian:13', 'unimportant')],
};
const LIBC6 = 'pkg:deb/debian/libc6@2.41-12%2Bdeb13u4?arch=amd64&distro=debian-13.7&upstream=glibc';
const LIBC_BIN = 'pkg:deb/debian/libc-bin@2.41-12%2Bdeb13u4?arch=amd64&distro=debian-13.7&upstream=glibc';

describe('severity precedence for OS packages (DEBIAN-CVE-2019-1010022)', () => {
  it('the real record is low from the distro, while its CVSS 9.8 is kept', () => {
    expect(REAL.cvssScore).toBeCloseTo(9.8, 1);
    expect(decideSeverity(REAL)).toEqual({ severity: 'low', source: 'distro', note: 'Debian: unimportant · disputed · no fix planned', disputed: true, noFixPlanned: true });
  });
  it('libc6 2.41-12+deb13u4 and libc-bin resolve to low / distro on suite Debian:13', () => {
    expect(decideSeverity(REAL, LIBC6)).toMatchObject({ severity: 'low', source: 'distro' });
    expect(decideSeverity(REAL, LIBC_BIN)).toMatchObject({ severity: 'low', source: 'distro' });
  });
  it('a record with only CVSS: severity from the score, source cvss', () => {
    expect(decideSeverity({ id: 'GHSA-x', cvssVector: NVD_VECTOR, cvssScore: 9.8, affected: [] })).toMatchObject({ severity: 'critical', source: 'cvss' });
  });
  it('"not yet assigned" is no rating: falls back to CVSS', () => {
    expect(decideSeverity({ ...REAL, affected: [suite('Debian:13', 'not yet assigned')] }, LIBC6)).toMatchObject({ severity: 'critical', source: 'cvss' });
  });
  it('"low*" (inferred) is low; end-of-life is low', () => {
    expect(distroRating([suite('Debian:13', 'low*')])?.severity).toBe('low');
    expect(distroRating([suite('Debian:13', 'low**')])?.severity).toBe('low');
    expect(distroRating([suite('Debian:11', 'end-of-life')])?.severity).toBe('low');
  });
  it('several suites: the component suite wins, otherwise the most severe', () => {
    const mixed = [suite('Debian:11', 'high'), suite('Debian:12', 'medium'), suite('Debian:13', 'low', '2.41-13')];
    expect(decideSeverity({ ...REAL, affected: mixed }, LIBC6)).toMatchObject({ severity: 'low', source: 'distro' });          // Debian:13
    expect(decideSeverity({ ...REAL, affected: mixed })).toMatchObject({ severity: 'high', source: 'distro' });                 // no component → most severe
    expect(decideSeverity({ ...REAL, affected: mixed }, 'pkg:deb/debian/libc6@2.36-9%2Bdeb12u4?upstream=glibc')).toMatchObject({ severity: 'medium' }); // no distro= → suite from +deb12u4
  });
  it('database_specific.severity is used when there is no distro rating and no CVSS', () => {
    expect(decideSeverity({ id: 'GHSA-y', cvssScore: null, databaseSeverity: 'MODERATE', affected: [] }, 'pkg:npm/x@1.0.0')).toMatchObject({ severity: 'medium', source: 'database' });
    expect(decideSeverity({ id: 'Z', cvssScore: null, affected: [] })).toMatchObject({ severity: 'unknown', source: 'unknown' });
  });
  it('a language package never takes a Debian urgency', () => {
    expect(decideSeverity(REAL, 'pkg:npm/glibc@1.0.0')).toMatchObject({ severity: 'critical', source: 'cvss' });
  });
});

describe('one advisory counted once per source package', () => {
  it('libc6 + libc-bin with the same advisory = 1 vulnerability · 2 packages', () => {
    const rows = [
      { advisoryId: 'DEBIAN-CVE-2019-1010022', packageKey: packageKeyOf(LIBC6), componentId: 'c-libc6', severity: 'low' as const },
      { advisoryId: 'DEBIAN-CVE-2019-1010022', packageKey: packageKeyOf(LIBC_BIN), componentId: 'c-libc-bin', severity: 'low' as const },
      { advisoryId: 'DEBIAN-CVE-2026-1', packageKey: 'Debian/openssl', componentId: 'c-openssl', severity: 'high' as const },
    ];
    const r = uniqueVulnerabilities(rows);
    expect(r.unique).toHaveLength(2);
    expect(r.packages).toBe(3);
  });
});

describe('Debian has not triaged it (DEBIAN-CVE-2025-8941, pam on Debian:13, audit 1.0.10 #4)', () => {
  it('keeps the record CVSS (7.8 → high) and says Debian has not triaged it', () => {
    const rec = { id: 'DEBIAN-CVE-2025-8941', cvssVector: 'CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', cvssScore: 7.8, affected: [{ package: { ecosystem: 'Debian:13', name: 'pam' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }], ecosystem_specific: { urgency: 'not yet assigned' } }] };
    expect(decideSeverity(rec, 'pkg:deb/debian/libpam0g@1.7.0-5?arch=amd64&distro=debian-13.7&upstream=pam')).toMatchObject({ severity: 'high', source: 'cvss', note: 'Debian: not yet triaged' });
  });
  it('no CVSS anywhere in OSV: the NVD score of the CVE (alias) decides, source alias', () => {
    const rec = { id: 'DEBIAN-CVE-2026-54369', cvssScore: null, aliasCvssScore: 7.5, affected: [{ package: { ecosystem: 'Debian:13', name: 'acl' }, ecosystem_specific: { urgency: 'not yet assigned' } }] };
    expect(decideSeverity(rec, 'pkg:deb/debian/libacl1@2.3.2-2?distro=debian-13.7&upstream=acl')).toMatchObject({ severity: 'high', source: 'alias', note: 'Debian: not yet triaged' });
  });
});

describe('canonical advisory id (#2: GHSA / PYSEC / DEBIAN-CVE of one CVE are one vulnerability)', () => {
  it('is the CVE alias, the lowest when several', () => {
    expect(canonicalAdvisoryId('GHSA-abcd-efgh-ijkl', ['CVE-2026-8643'])).toBe('CVE-2026-8643');
    expect(canonicalAdvisoryId('PYSEC-2026-99', ['CVE-2026-8643', 'GHSA-abcd-efgh-ijkl'])).toBe('CVE-2026-8643');
    expect(canonicalAdvisoryId('DEBIAN-CVE-2026-8643', [], ['CVE-2026-8643'])).toBe('CVE-2026-8643');
    expect(canonicalAdvisoryId('DEBIAN-CVE-2026-8643', null)).toBe('CVE-2026-8643');
    expect(canonicalAdvisoryId('GHSA-no-cve-yet', [])).toBe('GHSA-no-cve-yet');
  });
  it('unique counts key on the canonical id', () => {
    const rows = [
      { advisoryId: 'GHSA-abcd-efgh-ijkl', canonicalId: 'CVE-2026-8643', packageKey: 'pypi/pip', componentId: 'c1', severity: 'high' as const },
      { advisoryId: 'PYSEC-2026-99', canonicalId: 'CVE-2026-8643', packageKey: 'pypi/pip', componentId: 'c1', severity: 'medium' as const },
    ];
    const u = uniqueVulnerabilities(rows);
    expect(u.unique).toHaveLength(1);
    expect(u.unique[0]!.severity).toBe('high');
  });
});
