import { evaluateGate, GatePolicy } from './gate';

const prod: GatePolicy = { id: 'p1', name: 'Production baseline', action: 'block', environmentKinds: ['production'], rules: { maxSeverity: 'high', blockKev: true, blockSecrets: true, maxIacSeverity: 'critical', requireSbom: true, honourDecisions: true } };
const warnAll: GatePolicy = { id: 'p2', name: 'Advisory', action: 'warn', environmentKinds: [], rules: { maxSeverity: 'medium', blockKev: false, blockSecrets: false, maxIacSeverity: null, requireSbom: false, honourDecisions: true } };
const clean = { environmentKind: 'production', hasSbom: true, findings: { critical: 0, high: 0, medium: 0, low: 3, unknown: 0 }, kevOpen: 0, secretsOpen: 0, iacOpen: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 } };

describe('gate evaluation', () => {
  it('passes a clean subject', () => expect(evaluateGate([prod], clean).result).toBe('pass'));
  it('fails on severities above the maximum, KEV and secrets', () => {
    const r = evaluateGate([prod], { ...clean, findings: { ...clean.findings, critical: 2 }, kevOpen: 1, secretsOpen: 1 });
    expect(r.result).toBe('fail');
    expect(r.violations.map((v) => v.rule).sort()).toEqual(['block_kev', 'block_secrets', 'max_severity']);
  });
  it('honours environment kinds and warn-only policies', () => {
    expect(evaluateGate([prod], { ...clean, environmentKind: 'development', findings: { ...clean.findings, critical: 5 } }).result).toBe('pass');
    expect(evaluateGate([warnAll], { ...clean, environmentKind: 'development', findings: { ...clean.findings, high: 1 } }).result).toBe('warn');
  });
  it('requires an SBOM when asked', () => expect(evaluateGate([prod], { ...clean, hasSbom: false }).violations[0].rule).toBe('require_sbom'));
});

describe('max_sast_severity', () => {
  it('blocks on static-analysis findings at or above the configured severity, ignores below', () => {
    const { evaluateGate } = require('./gate') as typeof import('./gate');
    const zero = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    const pol = { id: 'p', name: 'Prod', action: 'block' as const, environmentKinds: ['production'], rules: { maxSeverity: null, blockKev: false, blockSecrets: false, maxIacSeverity: null, maxSastSeverity: 'high' as const, requireSbom: false, honourDecisions: true }, enforceOnDeploy: true };
    const base = { environmentKind: 'production', hasSbom: true, findings: zero, kevOpen: 0, secretsOpen: 0, iacOpen: zero };
    expect(evaluateGate([pol as never], { ...base, sastOpen: { ...zero, high: 2, medium: 5 } }).violations.map((v) => v.rule)).toEqual(['max_sast_severity']);
    expect(evaluateGate([pol as never], { ...base, sastOpen: { ...zero, medium: 5 } }).violations).toEqual([]);
    expect(evaluateGate([pol as never], { ...base }).violations).toEqual([]);   // no sast data yet: not a violation
  });
});

describe('partial rules objects', () => {
  it('a missing/null rule means no limit; booleans default; nothing prints undefined', () => {
    const { evaluateGate, normalizeRules } = require('./gate') as typeof import('./gate');
    const zero = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    expect(normalizeRules({ maxSastSeverity: 'low' } as never)).toEqual({ maxSeverity: null, blockKev: true, blockSecrets: true, maxIacSeverity: null, maxSastSeverity: 'low', requireSbom: true, honourDecisions: true });
    const pol = { id: 'p', name: 'Partial', action: 'block' as const, environmentKinds: [], rules: { maxSastSeverity: 'low' }, enforceOnDeploy: true };
    const ev = evaluateGate([pol as never], { environmentKind: 'production', hasSbom: true, findings: { ...zero, high: 76 }, kevOpen: 0, secretsOpen: 0, iacOpen: zero, sastOpen: { ...zero, low: 1 } });
    expect(ev.violations.map((v) => v.rule)).toEqual(['max_sast_severity']);   // 76 high are NOT a max_severity violation: no limit set
    expect(ev.violations.every((v) => !v.message.includes('undefined'))).toBe(true);
  });
});
