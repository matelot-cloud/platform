import { assertRealMatchId } from './exceptions.service';

describe('exceptions reject placeholder advisory ids (#7)', () => {
  it.each(['CVE-YYYY-YYYY', 'GHSA-xxxx-xxxx-xxxx', '<cve>', 'CVE-2026-example', ''])('rejects %s', (m) => {
    expect(() => assertRealMatchId('vulnerability', m)).toThrow(/not a real advisory id/);
  });
  it.each(['CVE-2019-1010022', 'GHSA-wf93-45jw-7689', 'DEBIAN-CVE-2025-8941', 'PYSEC-2024-12', 'RUSTSEC-2024-0001'])('accepts %s', (m) => {
    expect(assertRealMatchId('vulnerability', m)).toBe(m);
  });
  it('code rules only need to be non-placeholder', () => {
    expect(assertRealMatchId('code', 'KSV-0014')).toBe('KSV-0014');
    expect(() => assertRealMatchId('code', 'RULE-XXXX')).toThrow();
  });
});
