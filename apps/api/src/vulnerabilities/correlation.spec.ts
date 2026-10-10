/**
 * Offline end-to-end test of the correlation logic against a real database is done by the smoke
 * script (fake advisory source); here we pin the advisory→severity rules used by upsertAdvisory.
 */
import { cvss3BaseScore, severityFromScore } from './osv-mapping';

describe('advisory severity rules', () => {
  it('prefers the CVSS vector over the database severity label', () => {
    expect(severityFromScore(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'))).toBe('critical');
    expect(severityFromScore(cvss3BaseScore('CVSS:3.1/AV:L/AC:L/PR:L/UI:R/S:U/C:L/I:L/A:N'))).toBe('low');
  });
});
