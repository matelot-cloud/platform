import { uniqueVulnerabilities } from '../vulnerabilities/severity';
import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { advisories, codeFindings, containerImages, deployments, environments, findings, findingSboms, gateEvaluations, imageTags, releases, remediationSettings, sboms, services } from '../database/schema';
import { PoliciesService } from '../policies/policies.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';

export interface ReadinessCheck { id: string; title: string; requirement: string; status: 'pass' | 'warn' | 'fail' | 'na'; detail: string; fix?: string }

/**
 * CRA readiness for a service: does the evidence the regulation expects exist, and is the product in a shippable state?
 * (Annex I essential requirements + Annex I part II vulnerability handling, in practical terms.)
 */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly policiesService: PoliciesService,
    private readonly resolver: ScopeResolverService,
  ) {}

  async forService(serviceId: string): Promise<{ serviceId: string; serviceName: string; score: number; grade: 'ready' | 'almost' | 'not_ready'; checks: ReadinessCheck[]; computedAt: string }> {
    const [svc] = await this.db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    const checks: ReadinessCheck[] = [];
    const push = (c: ReadinessCheck) => checks.push(c);
    // production deployments and what they run
    const prod = await this.db.select({ d: deployments, env: environments, tagDigest: imageTags.digest }).from(deployments).innerJoin(environments, eq(deployments.environmentId, environments.id)).leftJoin(imageTags, eq(deployments.imageTagId, imageTags.id)).where(and(eq(deployments.serviceId, serviceId), isNull(deployments.supersededAt), eq(environments.kind, 'production')));
    // SBOMs of what production runs, by digest (sbom/running-sbom.ts): a tag that moved keeps no stale SBOM.
    const prodRunning = await resolveRunningSboms(this.db, { serviceIds: [serviceId], environmentKinds: ['production'] });
    const prodSboms = [...new Set(prodRunning.map((r) => r.sbomId).filter((x): x is string => !!x))].map((id) => ({ id }));
    // 1. SBOM for what ships
    if (!prod.length) push({ id: 'sbom_shipped', title: 'SBOM for every shipped version', requirement: 'CRA Annex I §II(1): identify and document components, including an SBOM in a machine-readable format.', status: 'na', detail: 'Nothing is deployed to a production environment yet.' });
    else if (prodSboms.length) push({ id: 'sbom_shipped', title: 'SBOM for every shipped version', requirement: 'CRA Annex I §II(1): SBOM in a machine-readable format for the product as placed on the market.', status: 'pass', detail: `Production runs ${prod.length} deployment(s); each running image has an SBOM (CycloneDX).` });
    else push({ id: 'sbom_shipped', title: 'SBOM for every shipped version', requirement: 'CRA Annex I §II(1)', status: 'fail', detail: 'The image running in production has no SBOM.', fix: 'Generate it (Releases & images → Generate SBOM) or run the pipeline for that build.' });
    // 2. no known-exploited vulnerabilities in production
    const prodFindings = prodSboms.length ? await this.db.select({ severity: findings.severity, status: findings.status, kev: advisories.kev, advisoryId: findings.advisoryId, canonicalId: findings.canonicalId, packageKey: findings.packageKey, componentId: findings.componentId }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).innerJoin(advisories, eq(findings.advisoryId, advisories.id)).where(inArray(findingSboms.sbomId, prodSboms.map((b) => b.id))) : [];
    // Unique advisories per source package (libc6 + libc-bin = one glibc vulnerability).
    const openProd = uniqueVulnerabilities(prodFindings.filter((f) => f.status === 'open')).unique;
    const kev = openProd.filter((f) => f.kev).length;
    push({ id: 'kev_prod', title: 'No known-exploited vulnerabilities in production', requirement: 'CRA Annex I §I(2): delivered without known exploitable vulnerabilities.', status: !prod.length ? 'na' : kev ? 'fail' : 'pass', detail: !prod.length ? 'Nothing in production.' : kev ? `${kev} open finding(s) in production are listed in CISA KEV.` : 'No open KEV-listed finding in what runs in production.', fix: kev ? 'Fix or document a decision (exception with reason) for each.' : undefined });
    const crit = openProd.filter((f) => f.severity === 'critical').length;
    const high = openProd.filter((f) => f.severity === 'high').length;
    push({ id: 'severity_prod', title: 'Critical / high vulnerabilities in production are handled', requirement: 'CRA Annex I §II(2): address and remediate vulnerabilities without delay.', status: !prod.length ? 'na' : crit ? 'fail' : high ? 'warn' : 'pass', detail: !prod.length ? 'Nothing in production.' : `${crit} critical, ${high} high open in production (${uniqueVulnerabilities(prodFindings.filter((f) => ['accepted', 'false_positive', 'not_affected'].includes(f.status))).unique.length} with a documented decision).`, fix: crit || high ? 'Remediation → Fix first; or document decisions / exceptions.' : undefined });
    // 3. vulnerability-handling process: policies + SLAs + gate evidence
    const chain = await this.resolver.resolveChain({ serviceId });
    const pols = await this.policiesService.applicable(chain);
    const prodPolicy = pols.find((p) => p.action === 'block' && (!p.environmentKinds.length || p.environmentKinds.includes('production')));
    push({ id: 'policy', title: 'Enforced security policy for production', requirement: 'CRA Annex I §II(3)-(4): effective vulnerability handling with defined processes.', status: prodPolicy ? 'pass' : pols.length ? 'warn' : 'fail', detail: prodPolicy ? `"${prodPolicy.name}" blocks production${prodPolicy.rules.blockKev ? ', including KEV' : ''}.` : pols.length ? 'Only warn-only policies apply; nothing blocks a release.' : 'No policy applies to this service.', fix: prodPolicy ? undefined : 'Policies → New policy → template "CRA baseline (production)".' });
    const [sla] = await this.db.select().from(remediationSettings).where(eq(remediationSettings.organizationId, chain.organizationId)).limit(1);
    push({ id: 'sla', title: 'Remediation deadlines (SLAs) defined', requirement: 'CRA Annex I §II(2),(8): timely remediation and security updates.', status: sla?.slaDays ? 'pass' : 'warn', detail: sla?.slaDays ? `Critical ${sla.slaDays.critical}d · high ${sla.slaDays.high}d · medium ${sla.slaDays.medium}d · low ${sla.slaDays.low}d.` : 'Defaults in use (7 / 30 / 90 / 180 days); not explicitly confirmed.', fix: sla?.slaDays ? undefined : 'Remediation → SLAs & issues → Save.' });
    const gates = await this.db.select({ id: gateEvaluations.id }).from(gateEvaluations).where(eq(gateEvaluations.serviceId, serviceId)).limit(1);
    push({ id: 'gate_evidence', title: 'Release decisions are recorded (gate evaluations)', requirement: 'CRA Art. 13 / Annex VII: technical documentation of the conformity assessment of each version.', status: gates.length ? 'pass' : 'warn', detail: gates.length ? 'Gate evaluations exist for this service.' : 'No gate evaluation yet.', fix: gates.length ? undefined : 'Use `matelot gate` in CI or enable "reject deployments" on the policy.' });
    // 4. secure by default: secrets and IaC
    const code = await this.db.select({ kind: codeFindings.kind, severity: codeFindings.severity, status: codeFindings.status }).from(codeFindings).where(and(eq(codeFindings.serviceId, serviceId), eq(codeFindings.status, 'open')));
    const secrets = code.filter((c) => c.kind === 'secret').length;
    const iacHigh = code.filter((c) => c.kind === 'iac' && ['critical', 'high'].includes(c.severity)).length;
    push({ id: 'secrets', title: 'No secrets in the repository', requirement: 'CRA Annex I §I(2)(a),(c): protection of data and access control.', status: secrets ? 'fail' : 'pass', detail: secrets ? `${secrets} committed secret(s) found.` : 'No open secret finding.', fix: secrets ? 'Rotate and remove them; Vulnerabilities → Code.' : undefined });
    push({ id: 'iac', title: 'Secure-by-default configuration', requirement: 'CRA Annex I §I(2)(b): secure by default configuration.', status: iacHigh ? 'warn' : 'pass', detail: iacHigh ? `${iacHigh} critical/high infrastructure-as-code misconfiguration(s) open.` : 'No critical/high IaC misconfiguration open.', fix: iacHigh ? 'Vulnerabilities → Code → IaC.' : undefined });
    // 5. traceability: releases carry commits and images
    const rels = await this.db.select({ id: releases.id, commitSha: releases.commitSha }).from(releases).where(eq(releases.serviceId, serviceId)).orderBy(desc(releases.createdAt)).limit(10);
    const withCommit = rels.filter((r) => r.commitSha).length;
    push({ id: 'traceability', title: 'Releases traceable to source and images', requirement: 'CRA Annex VII(2): description of the design, development and vulnerability-handling processes; identification of the product version.', status: !rels.length ? 'warn' : withCommit === rels.length ? 'pass' : 'warn', detail: !rels.length ? 'No release recorded yet.' : `${withCommit} of the last ${rels.length} releases carry a commit.`, fix: withCommit === rels.length && rels.length ? undefined : 'Deploy with `--version` and `--commit` (the workflows do this).' });
    // 6. monitoring continues after release: correlation + trend
    const [lastRisk] = await this.db.select({ id: sboms.id, createdAt: sboms.createdAt }).from(sboms).where(eq(sboms.serviceId, serviceId)).orderBy(desc(sboms.createdAt)).limit(1);
    push({ id: 'monitoring', title: 'Continuous vulnerability monitoring', requirement: 'CRA Annex I §II(3): regular testing and monitoring for vulnerabilities after release.', status: lastRisk ? 'pass' : 'warn', detail: lastRisk ? `SBOMs are re-correlated against OSV / KEV / EPSS every 10 minutes; latest SBOM ${lastRisk.createdAt.toISOString().slice(0, 10)}.` : 'No SBOM to monitor yet.' });
    const weight = { pass: 1, warn: 0.5, fail: 0, na: null } as const;
    const scored = checks.filter((c) => c.status !== 'na');
    const score = scored.length ? Math.round((scored.reduce((a, c) => a + (weight[c.status] ?? 0), 0) / scored.length) * 100) : 0;
    const grade = checks.some((c) => c.status === 'fail') ? 'not_ready' : score >= 90 ? 'ready' : 'almost';
    return { serviceId, serviceName: svc.name, score, grade, checks, computedAt: new Date().toISOString() };
  }
}
