/**
 * Explainable risk scoring for a service. Pure function: inputs are aggregates already computed from findings,
 * exposure and hygiene; output is a 0–100 score, a grade and the contributing factors.
 */
export interface RiskInput {
  criticality: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | null;
  /** Open findings with their context. */
  findings: { severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown'; kev: boolean; epss: number | null; fixAvailable: boolean; inProduction: boolean; internetFacing: boolean; ageDays: number; /** kinds of the environments this finding runs in (empty = not running anywhere) */ runsIn?: string[] }[];
  /** Days since the newest SBOM, null when none. */
  sbomAgeDays: number | null;
  /** Environments of the service and whether something with a known image/release runs there. */
  environments: { kind: string; internetFacing: boolean; deployed: boolean; sbomKnown: boolean }[];
}

export interface RiskResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  factors: {
    findingsPressure: number;
    exposureMultiplier: number;
    criticalityMultiplier: number;
    hygienePenalty: number;
    counts: { critical: number; high: number; medium: number; low: number; kev: number; fixable: number; inProduction: number; internetFacing: number; stale: number };
    notes: string[];
  };
}

const SEV_WEIGHT = { critical: 10, high: 5, medium: 2, low: 0.5, unknown: 1 } as const;
const CRIT_MULT = { CRITICAL: 1.3, HIGH: 1.15, MEDIUM: 1, LOW: 0.85 } as const;
/** Where a finding runs decides how much it weighs: production fully, pre-production half, development a quarter, nowhere a tenth. */
const ENV_WEIGHT: Record<string, number> = { production: 1, staging: 0.5, testing: 0.5, development: 0.25 };
export const envWeight = (kinds: string[] | undefined): number => (!kinds || !kinds.length ? 0.1 : Math.max(...kinds.map((k) => ENV_WEIGHT[k] ?? 0.5)));

export function scoreRisk(input: RiskInput): RiskResult {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, kev: 0, fixable: 0, inProduction: 0, internetFacing: 0, stale: 0, nonProductionOnly: 0, notRunning: 0 };
  let pressure = 0;
  let exposed = 0;
  for (const f of input.findings) {
    if (f.severity in counts) counts[f.severity as 'critical' | 'high' | 'medium' | 'low']++;
    let w: number = SEV_WEIGHT[f.severity];
    if (f.kev) {
      w *= 2;
      counts.kev++;
    }
    if (f.epss !== null && f.epss >= 0.1) w *= 1 + Math.min(1, f.epss);
    if (f.fixAvailable) {
      w *= 1.5;
      counts.fixable++;
    }
    if (f.ageDays > 30) {
      w *= 1.25;
      counts.stale++;
    }
    const place = envWeight(f.runsIn);
    w *= place;
    if (!f.runsIn?.length) counts.notRunning++;
    else if (!f.inProduction) counts.nonProductionOnly++;
    let e = 1;
    if (f.inProduction) {
      e *= 1.5;
      counts.inProduction++;
    }
    if (f.internetFacing) {
      e *= 1.5;
      counts.internetFacing++;
    }
    pressure += w;
    exposed += w * (e - 1);
  }
  const exposureMultiplier = pressure > 0 ? Number(((pressure + exposed) / pressure).toFixed(2)) : 1;
  const criticalityMultiplier = input.criticality ? CRIT_MULT[input.criticality] : 1;
  const notes: string[] = [];
  let hygiene = 0;
  if (input.sbomAgeDays === null) {
    hygiene += 15;
    notes.push('No SBOM: the service has never been scanned.');
  } else if (input.sbomAgeDays > 30) {
    hygiene += 8;
    notes.push(`Latest SBOM is ${input.sbomAgeDays} days old.`);
  }
  const prodEnvs = input.environments.filter((e) => e.kind === 'production');
  if (prodEnvs.some((e) => e.deployed && !e.sbomKnown)) {
    hygiene += 10;
    notes.push('Something runs in production without a scanned image or release.');
  }
  if (prodEnvs.length && !prodEnvs.some((e) => e.deployed)) notes.push('No deployment recorded for production yet.');
  // Saturating curve: 0 pressure → 0; ~60 (a handful of highs in prod) → ~50; 300+ → ~90.
  const raw = (pressure + exposed) * criticalityMultiplier;
  const curve = 100 * (1 - Math.exp(-raw / 90));
  const score = Math.max(0, Math.min(100, Math.round(curve + hygiene)));
  const grade = score < 15 ? 'A' : score < 30 ? 'B' : score < 50 ? 'C' : score < 70 ? 'D' : score < 85 ? 'E' : 'F';
  if (counts.kev) notes.push(`${counts.kev} known-exploited vulnerabilit${counts.kev === 1 ? 'y' : 'ies'} open.`);
  if (counts.fixable) notes.push(`${counts.fixable} finding${counts.fixable === 1 ? ' has' : 's have'} a fix available.`);
  if (counts.nonProductionOnly) notes.push(`${counts.nonProductionOnly} finding${counts.nonProductionOnly === 1 ? '' : 's'} run only in non-production environments (weighted 25–50%).`);
  if (counts.notRunning) notes.push(`${counts.notRunning} finding${counts.notRunning === 1 ? ' is' : 's are'} in builds that run nowhere (weighted 10%).`);
  if (counts.inProduction) notes.push(`${counts.inProduction} finding${counts.inProduction === 1 ? ' runs' : 's run'} in production${counts.internetFacing ? `, ${counts.internetFacing} internet-facing` : ''}.`);
  return { score, grade, factors: { findingsPressure: Number(pressure.toFixed(1)), exposureMultiplier, criticalityMultiplier, hygienePenalty: hygiene, counts, notes } };
}
