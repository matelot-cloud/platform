import { scoreRisk } from './scoring';

const env = (kind: string, deployed = true, sbomKnown = true, internetFacing = false) => ({ kind, internetFacing, deployed, sbomKnown });

describe('risk scoring', () => {
  it('is 0 / A for a clean, scanned, deployed service', () => {
    const r = scoreRisk({ criticality: 'MEDIUM', findings: [], sbomAgeDays: 2, environments: [env('production')] });
    expect(r.score).toBe(0);
    expect(r.grade).toBe('A');
  });

  it('penalises missing SBOMs and unscanned production', () => {
    const r = scoreRisk({ criticality: 'MEDIUM', findings: [], sbomAgeDays: null, environments: [env('production', true, false)] });
    expect(r.score).toBe(25);
    expect(r.factors.notes.length).toBe(2);
  });

  it('weights exposure, KEV and fixability', () => {
    const base = { severity: 'high' as const, kev: false, epss: null, fixAvailable: false, inProduction: false, internetFacing: false, ageDays: 3, runsIn: ['development'] };
    const dev = scoreRisk({ criticality: 'MEDIUM', findings: [base], sbomAgeDays: 1, environments: [env('development')] });
    const prod = scoreRisk({ criticality: 'MEDIUM', findings: [{ ...base, inProduction: true, internetFacing: true, runsIn: ['production'] }], sbomAgeDays: 1, environments: [env('production', true, true, true)] });
    const kevFix = scoreRisk({ criticality: 'CRITICAL', findings: [{ ...base, kev: true, fixAvailable: true, inProduction: true, internetFacing: true, runsIn: ['production'] }], sbomAgeDays: 1, environments: [env('production', true, true, true)] });
    expect(dev.score).toBeLessThan(prod.score);
    expect(prod.score).toBeLessThan(kevFix.score);
    expect(prod.factors.exposureMultiplier).toBe(2.25);
    expect(kevFix.grade).not.toBe('A');
    // where it runs matters: the same finding weighs 4× more in production than in development, and 10× more than in a build that runs nowhere
    const nowhere = scoreRisk({ criticality: 'MEDIUM', findings: [{ ...base, runsIn: [] }], sbomAgeDays: 1, environments: [env('development')] });
    expect(nowhere.factors.findingsPressure).toBeLessThan(dev.factors.findingsPressure);
    expect(scoreRisk({ criticality: 'MEDIUM', findings: [{ ...base, runsIn: ['production'] }], sbomAgeDays: 1, environments: [env('production')] }).factors.findingsPressure).toBeGreaterThan(dev.factors.findingsPressure * 3);
  });

  it('saturates below 100 with many findings', () => {
    const many = Array.from({ length: 80 }, () => ({ severity: 'critical' as const, kev: true, epss: 0.9, fixAvailable: true, inProduction: true, internetFacing: true, ageDays: 90 }));
    const r = scoreRisk({ criticality: 'CRITICAL', findings: many, sbomAgeDays: 1, environments: [env('production', true, true, true)] });
    expect(r.score).toBe(100);
    expect(r.grade).toBe('F');
  });
});
