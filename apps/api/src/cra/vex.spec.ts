import { buildOpenVex } from './vex';

const base = { advisory: 'CVE-2026-1', aliases: ['DEBIAN-CVE-2026-1'], note: null, fixedVersion: null, statusChangedAt: null };
const product = [{ purl: 'pkg:oci/demo@sha256:4a7bd707?repository_url=1.dkr.ecr.eu-central-1.amazonaws.com%2Fdemo' }];

describe('OpenVEX: one statement per vulnerability (audit #2)', () => {
  it('merges per vulnerability + status with every affected subcomponent', () => {
    const vex = buildOpenVex({ author: 'a', product, timestamp: 't', findings: [
      { ...base, component: 'libc6@2.41', purl: 'pkg:deb/debian/libc6@2.41', status: 'open' },
      { ...base, component: 'libc-bin@2.41', purl: 'pkg:deb/debian/libc-bin@2.41', status: 'open' },
      { ...base, advisory: 'CVE-2026-2', component: 'openssl@3', purl: 'pkg:deb/debian/openssl@3', status: 'open' },
    ] });
    expect(vex.statements).toHaveLength(2);
    const s1 = vex.statements.find((s) => s.vulnerability.name === 'CVE-2026-1')!;
    expect(s1.status).toBe('under_investigation');
    expect((s1.products[0] as { subcomponents: { '@id': string }[] }).subcomponents.map((x) => x['@id'])).toEqual(['pkg:deb/debian/libc6@2.41', 'pkg:deb/debian/libc-bin@2.41']);
    expect(s1.products[0]!['@id']).not.toMatch(/tag=/);
  });
  it('different statuses of one vulnerability stay separate statements', () => {
    const vex = buildOpenVex({ author: 'a', product, timestamp: 't', findings: [
      { ...base, component: 'a@1', purl: 'pkg:npm/a@1', status: 'open' },
      { ...base, component: 'b@1', purl: 'pkg:npm/b@1', status: 'fixed' },
    ] });
    expect(vex.statements.map((s) => s.status).sort()).toEqual(['fixed', 'under_investigation']);
  });
});

describe('a finding fixed at service level is still AFFECTED in the release that contained it', () => {
  it('fixed_later → affected with the fix in action_statement, never dropped', () => {
    const vex = buildOpenVex({ author: 'a', product, timestamp: 't', findings: [
      { ...base, advisory: 'CVE-2018-7750', aliases: ['GHSA-232r-66cg-79px'], component: 'paramiko@2.4.0', purl: 'pkg:pypi/paramiko@2.4.0', status: 'fixed_later', fixedVersion: '2.4.1', note: 'present in 1.0.22; no longer present at service level since 2026-10-03' },
    ] });
    expect(vex.statements).toHaveLength(1);
    expect(vex.statements[0]).toMatchObject({ status: 'affected', vulnerability: { name: 'CVE-2018-7750' } });
    expect((vex.statements[0] as { action_statement: string }).action_statement).toMatch(/Affected in this version.*fix 2\.4\.1/);
  });
});
