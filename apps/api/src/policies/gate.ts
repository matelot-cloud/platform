import type { PolicyRules, Severity } from '../database/schema';

export interface GateInput {
  environmentKind: string | null;
  hasSbom: boolean;
  /** Open (or, when decisions are ignored, all non-fixed) dependency findings by severity. */
  findings: Record<Severity, number>;
  kevOpen: number;
  secretsOpen: number;
  iacOpen: Record<Severity, number>;
  /** Open static-analysis (SAST) findings by severity. */
  sastOpen?: Record<Severity, number>;
  /** What require_sbom says when there is no SBOM (defaults to the image wording). */
  noSbomMessage?: string;
}
/** Rules as stored may be partial (older rows, `--body` patches): a missing or null rule means "no limit" / default. */
export const DEFAULT_RULES: PolicyRules = { maxSeverity: null, blockKev: true, blockSecrets: true, maxIacSeverity: null, maxSastSeverity: null, requireSbom: true, honourDecisions: true };
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
export function normalizeRules(r: Partial<PolicyRules> | null | undefined): PolicyRules {
  const sev = (v: unknown) => (typeof v === 'string' && SEVERITIES.has(v) ? (v as PolicyRules['maxSeverity']) : null);
  return {
    maxSeverity: sev(r?.maxSeverity),
    blockKev: typeof r?.blockKev === 'boolean' ? r.blockKev : DEFAULT_RULES.blockKev,
    blockSecrets: typeof r?.blockSecrets === 'boolean' ? r.blockSecrets : DEFAULT_RULES.blockSecrets,
    maxIacSeverity: sev(r?.maxIacSeverity),
    maxSastSeverity: sev(r?.maxSastSeverity),
    requireSbom: typeof r?.requireSbom === 'boolean' ? r.requireSbom : DEFAULT_RULES.requireSbom,
    honourDecisions: typeof r?.honourDecisions === 'boolean' ? r.honourDecisions : DEFAULT_RULES.honourDecisions,
  };
}

export interface GatePolicy { id: string; name: string; action: 'block' | 'warn'; environmentKinds: string[]; rules: PolicyRules }
export interface Violation { policyId: string; policyName: string; action: 'block' | 'warn'; rule: string; message: string; count?: number }

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
/** Severities strictly worse than the tolerated maximum. */
const above = (max: Severity | null): Severity[] => (max === null ? [] : ORDER.slice(0, ORDER.indexOf(max)));
const atOrAbove = (min: Severity | null): Severity[] => (min === null ? [] : ORDER.slice(0, ORDER.indexOf(min) + 1));

/** Pure evaluation: policies × facts → violations and an overall result. */
export function evaluateGate(policies: GatePolicy[], input: GateInput): { result: 'pass' | 'warn' | 'fail'; violations: Violation[]; applied: string[] } {
  const applicable = policies.filter((p) => !p.environmentKinds.length || !input.environmentKind || p.environmentKinds.includes(input.environmentKind));
  const violations: Violation[] = [];
  for (const p of applicable) {
    const v = (rule: string, message: string, count?: number) => violations.push({ policyId: p.id, policyName: p.name, action: p.action, rule, message, count });
    const r = normalizeRules(p.rules);
    if (r.requireSbom && !input.hasSbom) v('require_sbom', input.noSbomMessage ?? 'The image has no SBOM (not scanned), so its vulnerabilities are unknown.');
    if (r.maxSeverity) {
      const sev = above(r.maxSeverity);
      const n = sev.reduce((a, s) => a + (input.findings[s] ?? 0), 0);
      if (n) v('max_severity', `${n} open ${sev.join('/')} vulnerabilit${n === 1 ? 'y' : 'ies'} (policy allows up to ${r.maxSeverity}).`, n);
    }
    if (r.blockKev && input.kevOpen) v('block_kev', `${input.kevOpen} open vulnerabilit${input.kevOpen === 1 ? 'y is' : 'ies are'} listed in CISA KEV (known exploited).`, input.kevOpen);
    if (r.blockSecrets && input.secretsOpen) v('block_secrets', `${input.secretsOpen} secret${input.secretsOpen === 1 ? '' : 's'} committed in the repository.`, input.secretsOpen);
    if (r.maxSastSeverity) {
      const sev = atOrAbove(r.maxSastSeverity);
      const n = sev.reduce((a, s) => a + (input.sastOpen?.[s] ?? 0), 0);
      if (n) v('max_sast_severity', `${n} code finding${n === 1 ? '' : 's'} (static analysis) at ${r.maxSastSeverity} or above.`, n);
    }
    if (r.maxIacSeverity) {
      const sev = atOrAbove(r.maxIacSeverity);
      const n = sev.reduce((a, s) => a + (input.iacOpen[s] ?? 0), 0);
      if (n) v('max_iac_severity', `${n} infrastructure-as-code misconfiguration${n === 1 ? '' : 's'} at ${r.maxIacSeverity} or above.`, n);
    }
  }
  const result = violations.some((x) => x.action === 'block') ? 'fail' : violations.length ? 'warn' : 'pass';
  return { result, violations, applied: applicable.map((p) => p.id) };
}
