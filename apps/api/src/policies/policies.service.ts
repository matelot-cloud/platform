import { releaseImage } from '../sbom/running-sbom';
import { uniqueVulnerabilities } from '../vulnerabilities/severity';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { userIdOrNull } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { advisories, codeFindings, containerImages, environments, findings, findingSboms, gateEvaluations, imageTags, jobs, pipelines, policies, PolicyRules, releases, sboms, services, Severity } from '../database/schema';
import { ScopeChain } from '../rbac/scope.types';
import { evaluateGate, normalizeRules, GatePolicy, Violation, CREATE_DEFAULTS } from './gate';
import { NotificationsService } from '../notifications/notifications.service';
import { Optional } from '@nestjs/common';

const zero = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });

export interface GateSubject {
  imageRef?: string;
  digest?: string;
  version?: string;
  ref?: string;
  /** Commit the subject was built / checked out from (pipelines). */
  commitSha?: string;
  pipelineId?: string;
  /** An SBOM chosen by the caller (a pipeline's own sbom job): evaluated as is, no lookup. */
  sbomId?: string;
}

/** Gate violation for an SBOM that is not correlated yet (pending) or failed to correlate: blocks, whatever the policies say. */
export function correlationGateViolation(status: string | null, error: string | null): Violation | null {
  if (!status || status === 'done') return null;
  return { policyId: 'matelot:correlation', policyName: 'Matelot', action: 'block', rule: 'correlated_sbom', message: status === 'failed' ? `SBOM correlation failed (${error ?? 'unknown error'}): findings unknown, re-run correlation` : 'SBOM not correlated yet: findings unknown, retry in a minute' };
}

@Injectable()
export class PoliciesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- policies

  /** Policies that apply on a scope chain: its own plus those inherited from parents (organization → … → project). */
  async applicable(chain: ScopeChain): Promise<GatePolicy[]> {
    const refs = chain.refs.map((r) => `${r.type}:${r.id}`);
    const rows = await this.db.select().from(policies).where(and(eq(policies.organizationId, chain.organizationId), eq(policies.enabled, true)));
    return rows.filter((p) => refs.includes(`${p.scopeType}:${p.scopeId}`)).map((p) => ({ id: p.id, name: p.name, action: p.action, environmentKinds: p.environmentKinds, rules: p.rules, enforceOnDeploy: p.enforceOnDeploy }) as GatePolicy & { enforceOnDeploy: boolean });
  }

  /** Full policy rows in force on a scope: defined here or inherited from a parent (marked). */
  async inForce(chain: ScopeChain) {
    const refs = chain.refs.map((r) => `${r.type}:${r.id}`);
    const here = `${chain.target.type}:${chain.target.id}`;
    const rows = await this.db.select().from(policies).where(eq(policies.organizationId, chain.organizationId)).orderBy(desc(policies.createdAt));
    return rows.filter((p) => refs.includes(`${p.scopeType}:${p.scopeId}`)).map((p) => ({ ...p, inherited: `${p.scopeType}:${p.scopeId}` !== here }));
  }

  async listForOrganization(organizationId: string) {
    return this.db.select().from(policies).where(eq(policies.organizationId, organizationId)).orderBy(desc(policies.createdAt));
  }

  async create(user: AuthenticatedUser, chain: ScopeChain, input: { name: string; description?: string; environmentKinds?: string[]; rules: PolicyRules; action?: 'block' | 'warn'; enforceOnDeploy?: boolean }) {
    if (!input.name?.trim()) throw new BadRequestException('name is required');
    input = { ...input, rules: normalizeRules(input.rules, CREATE_DEFAULTS) };
    const [row] = await this.db.insert(policies).values({ organizationId: chain.organizationId, scopeType: chain.target.type, scopeId: chain.target.id, name: input.name.trim(), description: input.description ?? null, environmentKinds: input.environmentKinds ?? [], rules: input.rules, action: input.action ?? 'block', enforceOnDeploy: input.enforceOnDeploy ?? false, createdById: userIdOrNull(user) }).returning();
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(user), action: 'policy.created', resourceType: 'policy', resourceId: row.id, after: { name: row.name, scope: `${row.scopeType}:${row.scopeId}`, rules: row.rules, action: row.action, enforceOnDeploy: row.enforceOnDeploy } });
    return row;
  }

  async update(user: AuthenticatedUser, policyId: string, patch: Partial<{ name: string; description: string | null; enabled: boolean; environmentKinds: string[]; rules: PolicyRules; action: 'block' | 'warn'; enforceOnDeploy: boolean }>) {
    const [before] = await this.db.select().from(policies).where(eq(policies.id, policyId)).limit(1);
    if (!before) throw new NotFoundException('Policy not found');
    // a partial rules object is a patch of the stored rules, never a replacement with holes
    if (patch.rules) patch = { ...patch, rules: normalizeRules({ ...before.rules, ...patch.rules }) };
    const [after] = await this.db.update(policies).set({ ...patch, updatedAt: new Date() }).where(eq(policies.id, policyId)).returning();
    await this.audit.record({ organizationId: before.organizationId, actor: userActor(user), action: 'policy.updated', resourceType: 'policy', resourceId: policyId, before: { enabled: before.enabled, rules: before.rules, action: before.action }, after: patch });
    return after;
  }

  async remove(user: AuthenticatedUser, policyId: string) {
    const [before] = await this.db.delete(policies).where(eq(policies.id, policyId)).returning();
    if (!before) throw new NotFoundException('Policy not found');
    await this.audit.record({ organizationId: before.organizationId, actor: userActor(user), action: 'policy.deleted', resourceType: 'policy', resourceId: policyId, before: { name: before.name } });
    return { deleted: true };
  }

  async policyById(policyId: string) {
    const [row] = await this.db.select().from(policies).where(eq(policies.id, policyId)).limit(1);
    if (!row) throw new NotFoundException('Policy not found');
    return row;
  }

  // ---------------------------------------------------------------- facts

  /** Resolves the subject to an SBOM (image by digest / tag, or release source SBOM) and counts what matters. */
  private async facts(serviceId: string, subject: GateSubject, honourDecisions: boolean) {
    let sbomId: string | null = null;
    if (subject.sbomId) {
      const [own] = await this.db.select({ id: sboms.id }).from(sboms).where(and(eq(sboms.id, subject.sbomId), eq(sboms.serviceId, serviceId))).limit(1);
      sbomId = own?.id ?? null;
    }
    const digest = subject.digest ?? (subject.imageRef?.includes('@sha256:') ? subject.imageRef.split('@')[1] : null);
    const tagName = !digest && subject.imageRef?.includes(':') ? subject.imageRef.split(/:(?=[^/]+$)/)[1] : null;
    const imageName = subject.imageRef ? subject.imageRef.split('@')[0].replace(/:[^/:]+$/, '') : null;
    const tagRows = await this.db.select({ id: imageTags.id, digest: imageTags.digest, tag: imageTags.tag, image: containerImages.name }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(eq(containerImages.serviceId, serviceId));
    const candidates = digest ? tagRows.filter((t) => t.digest === digest) : tagName ? tagRows.filter((t) => t.tag === tagName && (!imageName || t.image === imageName)) : [];
    // The SBOM of the candidate image is the one of its DIGEST (a tag name is resolved to its current digest).
    const candDigests = [...new Set([digest, ...candidates.map((c) => c.digest)].filter((x): x is string => !!x).map((x) => x.toLowerCase()))];
    if (!sbomId && candDigests.length) {
      const b = await this.db.select({ id: sboms.id }).from(sboms).where(and(eq(sboms.serviceId, serviceId), inArray(sboms.imageDigest, candDigests))).orderBy(desc(sboms.createdAt)).limit(1);
      sbomId = b[0]?.id ?? null;
    }
    // The digest being evaluated (from the subject, or the named tag's current digest). Recorded with the evaluation.
    const evaluatedDigest = digest?.toLowerCase() ?? candidates.find((c) => c.digest)?.digest?.toLowerCase() ?? null;
    let releaseId: string | null = null;
    // Version / release fallback ONLY for subjects that name no image. An image subject whose digest has no SBOM yet
    // must stay "no SBOM" (→ pending): another digest of the same version is another image, and evaluating its SBOM
    // once rejected a clean build with a rebuilt sibling's critical (run #17, 2026-10-02).
    // A --ref subject (the CI `security` job, before any image exists): dependency rules read the newest SOURCE SBOM
    // of the service; code rules (secrets, IaC, SAST) never needed an image. Nothing here evaluates another image's SBOM.
    if (!sbomId && subject.ref && !subject.version && !evaluatedDigest && !tagName) {
      const [src] = await this.db.select({ id: sboms.id }).from(sboms).where(and(eq(sboms.serviceId, serviceId), eq(sboms.target, 'source'))).orderBy(desc(sboms.createdAt)).limit(1);
      sbomId = src?.id ?? null;
    }
    if (!sbomId && subject.version && !evaluatedDigest && !tagName) {
      const [rel] = await this.db.select({ id: releases.id }).from(releases).where(and(eq(releases.serviceId, serviceId), eq(releases.version, subject.version.replace(/^v(?=\d)/, '')))).limit(1);
      releaseId = rel?.id ?? null;
      if (releaseId) {
        // Image SBOM of the release digest (what its deployments recorded), else the release's source SBOM.
        const relDigests = (await releaseImage(this.db, releaseId)).digests;
        if (relDigests.length) {
          const [b] = await this.db.select({ id: sboms.id }).from(sboms).where(and(eq(sboms.serviceId, serviceId), inArray(sboms.imageDigest, relDigests))).orderBy(desc(sboms.createdAt)).limit(1);
          sbomId = b?.id ?? null;
        }
        if (!sbomId) {
          const b = await this.db.select({ id: sboms.id, target: sboms.target }).from(sboms).where(and(eq(sboms.serviceId, serviceId), eq(sboms.releaseId, releaseId))).orderBy(desc(sboms.createdAt)).limit(5);
          sbomId = (b.find((x) => x.target === 'image') ?? b[0])?.id ?? null;
        }
      }
    }
    const sbomDigest: string | null = sbomId ? (await this.db.select({ d: sboms.imageDigest }).from(sboms).where(eq(sboms.id, sbomId)).limit(1))[0]?.d ?? null : null;
    let version = subject.version ?? null;
    if (!version && candidates.length) {
      const [rel] = await this.db.select({ version: releases.version }).from(imageTags).innerJoin(releases, eq(imageTags.releaseId, releases.id)).where(inArray(imageTags.id, candidates.map((c) => c.id))).limit(1);
      version = rel?.version ?? null;
    }
    const counts = zero();
    let kevOpen = 0;
    let packageMatches = 0;
    if (sbomId) {
      const statuses = honourDecisions ? ['open'] : ['open', 'accepted', 'false_positive', 'not_affected'];
      const rows = await this.db.select({ severity: findings.severity, kev: advisories.kev, advisoryId: findings.advisoryId, canonicalId: findings.canonicalId, packageKey: findings.packageKey, componentId: findings.componentId }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).innerJoin(advisories, eq(findings.advisoryId, advisories.id)).where(and(eq(findingSboms.sbomId, sbomId), inArray(findings.status, statuses as ('open' | 'accepted' | 'false_positive' | 'not_affected')[])));
      // One advisory per source package counts once (libc6 + libc-bin are both glibc); per-component findings stay for remediation.
      const { unique, packages } = uniqueVulnerabilities(rows);
      for (const r of unique) { counts[r.severity]++; if (r.kev) kevOpen++; }
      packageMatches = packages;
    }
    const codeStatuses = honourDecisions ? ['open'] : ['open', 'accepted', 'false_positive'];
    const code = await this.db.select({ kind: codeFindings.kind, severity: codeFindings.severity }).from(codeFindings).where(and(eq(codeFindings.serviceId, serviceId), inArray(codeFindings.status, codeStatuses as ('open' | 'accepted' | 'false_positive')[])));
    const iacOpen = zero();
    const sastOpen = zero();
    let secretsOpen = 0;
    for (const c of code) { if (c.kind === 'secret') secretsOpen++; else if (c.kind === 'iac') iacOpen[c.severity]++; else if (c.kind === 'sast') sastOpen[c.severity]++; }
    return { sbomId, sbomDigest, evaluatedDigest, version, releaseId, findings: counts, packageMatches, kevOpen, secretsOpen, iacOpen, sastOpen };
  }

  // ---------------------------------------------------------------- evaluation

  /** Evaluate a subject against the policies of an environment's chain; stores and returns the evaluation. */
  /**
   * Waits (polling) until an SBOM's correlation is done or failed, at most `timeoutMs`. Returns the final status.
   * CI calls the gate right after pushing an image: the SBOM is usually still being correlated for a few seconds.
   */
  async awaitCorrelation(sbomId: string, timeoutMs: number): Promise<{ status: 'done' | 'pending' | 'failed'; error: string | null; waitedMs: number }> {
    const started = Date.now();
    // A gate is a reason to retry a failed correlation now (the periodic loop retries with backoff anyway).
    if (timeoutMs > 0) await this.db.update(sboms).set({ correlationStatus: 'pending', correlationNextRetryAt: new Date() }).where(and(eq(sboms.id, sbomId), eq(sboms.correlationStatus, 'failed'))).catch(() => undefined);
    for (;;) {
      const [row] = await this.db.select({ st: sboms.correlationStatus, err: sboms.correlationError }).from(sboms).where(eq(sboms.id, sbomId)).limit(1);
      const st = (row?.st ?? 'done') as 'done' | 'pending' | 'failed'; // no row / null status: predates tracking, i.e. correlated under the old flow
      if (st !== 'pending' || Date.now() - started >= timeoutMs) return { status: st, error: row?.err ?? null, waitedMs: Date.now() - started };
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, timeoutMs - (Date.now() - started)))));
    }
  }

  async evaluate(chain: ScopeChain, subject: GateSubject, options: { environmentId?: string; actor?: string; jobId?: string; deploymentId?: string; waitCorrelationMs?: number } = {}) {
    const serviceId = chain.serviceId!;
    const [env] = options.environmentId ? await this.db.select({ kind: environments.kind, name: environments.name }).from(environments).where(eq(environments.id, options.environmentId)).limit(1) : [null];
    let pols: GatePolicy[] = await this.applicable(chain);
    // No target environment (pipeline stage): environment-specific policies still run, but only warn — they block at the deploy.
    if (!options.environmentId) pols = pols.map((p) => (p.environmentKinds.length ? { ...p, action: 'warn' as const, name: `${p.name} (${p.environmentKinds.join('/')})` } : p));
    const honour = pols.every((p) => p.rules.honourDecisions);
    // ---- correlation wait (CI calls the gate right after a push)
    const waitMs = Math.min(options.waitCorrelationMs ?? 0, 25_000); // short requests: the CLI loops, an ingress never sees a long call
    const namesImage = !!(subject.imageRef || subject.digest);
    const started = Date.now();
    let f = await this.facts(serviceId, subject, honour);
    // 3. right after a push the SBOM job may not have run: wait for the digest's SBOM to exist at all
    while (namesImage && !f.sbomId && Date.now() - started < waitMs) {
      await new Promise((r) => setTimeout(r, 1000));
      f = await this.facts(serviceId, subject, honour);
    }
    let correlation: { status: 'done' | 'pending' | 'failed' | 'no_sbom'; error: string | null; waitedMs: number } | null = null;
    if (f.sbomId) {
      correlation = await this.awaitCorrelation(f.sbomId, Math.max(0, waitMs - (Date.now() - started)));
      if (correlation.status === 'done' && waitMs > 0) f = await this.facts(serviceId, subject, honour); // findings were linked while we waited
      correlation.waitedMs = Date.now() - started;
    } else if (namesImage && (options.waitCorrelationMs ?? 0) > 0) {
      // nobody has scanned this image (yet): not a pass, whatever the policies require
      correlation = { status: 'no_sbom', error: null, waitedMs: Date.now() - started };
    }
    const uncorrelated = correlation?.status === 'no_sbom' ? { policyId: 'matelot:correlation', policyName: 'Matelot', action: 'block' as const, rule: 'correlated_sbom', message: 'No SBOM for this image yet: nothing has been scanned, findings unknown. Retry when the SBOM job has run.' } : correlationGateViolation(correlation?.status ?? null, correlation?.error ?? null);
    const noSubject = !subject.imageRef && !subject.digest && !subject.version && !subject.ref && !subject.sbomId;
    const noSbomMessage = noSubject
      ? 'No ref or image to evaluate: the gate has no commit, version or image, so it cannot pick an SBOM.'
      : !namesImage && !subject.version && subject.ref
        ? `No SBOM for ref ${subject.ref}${subject.commitSha && subject.commitSha !== subject.ref ? ` (commit ${subject.commitSha.slice(0, 12)})` : ''}: run the pipeline's sbom job or upload one, so dependency vulnerabilities are known.`
        : !namesImage && subject.version
          ? `No SBOM for version ${subject.version}: neither its image nor its source has been scanned.`
          : undefined;
    const evaluated = evaluateGate(pols, { environmentKind: env?.kind ?? null, hasSbom: !!f.sbomId, findings: f.findings, kevOpen: f.kevOpen, secretsOpen: f.secretsOpen, iacOpen: f.iacOpen, sastOpen: f.sastOpen, noSbomMessage });
    // Fail safe: an SBOM whose findings are not linked yet (or whose correlation failed) looks clean but is unknown.
    const result = uncorrelated ? 'fail' : evaluated.result;
    const violations = uncorrelated ? [uncorrelated, ...evaluated.violations] : evaluated.violations;
    const applied = evaluated.applied;
    const [row] = await this.db.insert(gateEvaluations).values({ organizationId: chain.organizationId, serviceId, environmentId: options.environmentId ?? null, subject: { ...subject, version: subject.version ?? f.version ?? null, evaluatedDigest: f.evaluatedDigest, sbomDigest: f.sbomDigest, sbomId: f.sbomId ?? undefined, sbomSource: f.sbomId ? (subject.sbomId && f.sbomId === subject.sbomId ? 'pipeline' : 'lookup') : undefined }, result, violations, policyIds: applied, jobId: options.jobId ?? null, deploymentId: options.deploymentId ?? null, actor: options.actor ?? null }).returning();
    if (result === 'fail' && this.notifications) { const [svc] = await this.db.select({ name: services.name }).from(services).where(eq(services.id, serviceId)).limit(1); void this.notifications.notify({ event: 'gate.fail', organizationId: chain.organizationId, projectId: chain.projectId, severity: 'warning', title: `Gate failed · ${svc?.name ?? 'service'}${env ? ` → ${env.name}` : ' (pipeline)'}`, text: violations.filter((v) => v.action === 'block').map((v) => `• ${v.policyName}: ${v.message}`).join('\n'), fields: { subject: subject.version ?? subject.imageRef ?? subject.ref, by: options.actor ?? 'platform' }, key: `gate.fail:${serviceId}:${subject.version ?? subject.digest ?? subject.imageRef ?? subject.ref ?? ''}`, dedupeHours: 6 }); }
    await this.audit.record({ organizationId: chain.organizationId, actor: SYSTEM_ACTOR, action: `gate.${result}`, resourceType: 'gate_evaluation', resourceId: row.id, after: { subject, environmentId: options.environmentId ?? null, violations: violations.map((v) => `${v.policyName}: ${v.message}`), actor: options.actor ?? null } });
    // While not correlated the counts are not knowledge: do not return them (they would look real).
    if (uncorrelated) return { ...row, pending: true, correlation: { status: correlation!.status, error: correlation!.error, waitedMs: correlation!.waitedMs }, facts: { sbomId: f.sbomId, sbomDigest: f.sbomDigest, evaluatedDigest: f.evaluatedDigest, findings: null, packageMatches: null, kevOpen: null, secretsOpen: f.secretsOpen, iacOpen: f.iacOpen, sastOpen: f.sastOpen }, policies: pols.map((p) => ({ id: p.id, name: p.name, action: p.action })), violations, result };
    return { ...row, pending: false, correlation: correlation ? { status: correlation.status, error: null, waitedMs: correlation.waitedMs } : null, facts: { sbomId: f.sbomId, sbomDigest: f.sbomDigest, evaluatedDigest: f.evaluatedDigest, findings: f.findings, packageMatches: f.packageMatches, kevOpen: f.kevOpen, secretsOpen: f.secretsOpen, iacOpen: f.iacOpen, sastOpen: f.sastOpen }, policies: pols.map((p) => ({ id: p.id, name: p.name, action: p.action })) };
  }

  /** Throws when a blocking policy with enforceOnDeploy fails for this deployment. */
  async enforceOnDeploy(chain: ScopeChain, environmentId: string, subject: GateSubject, actor: string | null, waitCorrelationMs = 0) {
    const pols = (await this.applicable(chain)) as (GatePolicy & { enforceOnDeploy: boolean })[];
    if (!pols.some((p) => p.enforceOnDeploy && p.action === 'block')) return null;
    const ev = await this.evaluate(chain, subject, { environmentId, actor: actor ?? undefined, waitCorrelationMs });
    if ((ev as { pending?: boolean }).pending) throw new ConflictException({ statusCode: 409, code: 'correlation_pending', status: (ev as { correlation?: { status: string } }).correlation?.status ?? 'pending', message: `SBOM ${(ev as { correlation?: { status: string; error: string | null } }).correlation?.status === 'failed' ? `correlation failed (${(ev as { correlation?: { error: string | null } }).correlation?.error ?? 'unknown error'})` : (ev as { correlation?: { status: string } }).correlation?.status === 'no_sbom' ? 'not available yet (nothing scanned)' : 'correlation not finished yet'}: findings unknown, deployment not evaluated. Retry, or wait longer (waitCorrelation).` });
    const blocking = (ev.violations as Violation[]).filter((v) => v.action === 'block' && (v.policyId === 'matelot:correlation' || pols.find((p) => p.id === v.policyId)?.enforceOnDeploy));
    if (blocking.length && this.notifications) { const [svc] = await this.db.select({ name: services.name }).from(services).where(eq(services.id, chain.serviceId!)).limit(1); void this.notifications.notify({ event: 'deployment.rejected', organizationId: chain.organizationId, projectId: chain.projectId, severity: 'critical', title: `Deployment rejected · ${svc?.name ?? 'service'}`, text: blocking.map((v) => `• ${v.policyName}: ${v.message}`).join('\n'), fields: { subject: subject.version ?? subject.imageRef, by: actor ?? 'unknown' } }); }
    if (blocking.length) throw new ForbiddenException(`Deployment rejected by policy: ${blocking.map((v) => `${v.policyName} — ${v.message}`).join(' · ')}`);
    return ev;
  }

  async latestForEnvironment(environmentId: string) {
    const [row] = await this.db.select().from(gateEvaluations).where(eq(gateEvaluations.environmentId, environmentId)).orderBy(desc(gateEvaluations.evaluatedAt)).limit(1);
    return row ?? null;
  }

  async listForService(serviceId: string, limit = 20) {
    return this.db.select().from(gateEvaluations).where(eq(gateEvaluations.serviceId, serviceId)).orderBy(desc(gateEvaluations.evaluatedAt)).limit(limit);
  }

  /**
   * Server-side execution of queued `policy_eval` pipeline jobs (no runner needed). The subject is the pipeline's ref and
   * commit (payload first, else the pipeline's — a run without --ref works on the default branch), and when the pipeline
   * ran an sbom job its own SBOM is evaluated rather than "the newest source SBOM of the service".
   */
  async evaluateJob(job: { id: string; serviceId: string | null; payload: Record<string, unknown>; pipelineId: string | null }, chain: ScopeChain) {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const [pipeline] = job.pipelineId ? await this.db.select({ id: pipelines.id, ref: pipelines.ref, commitSha: pipelines.commitSha }).from(pipelines).where(eq(pipelines.id, job.pipelineId)).limit(1) : [];
    const ref = str(job.payload.ref) ?? str(pipeline?.ref);
    const commitSha = str(job.payload.commitSha) ?? str(pipeline?.commitSha) ?? (ref && /^[0-9a-f]{40}$/i.test(ref) ? ref : undefined);
    const version = str(job.payload.version);
    const subject: GateSubject = { ref, version, ...(commitSha ? { commitSha } : {}), ...(pipeline ? { pipelineId: pipeline.id } : {}) };
    // the SBOM this pipeline produced (its sbom job), newest first
    if (pipeline && job.serviceId) {
      const [own] = await this.db.select({ id: sboms.id }).from(sboms).innerJoin(jobs, eq(sboms.jobId, jobs.id)).where(and(eq(jobs.pipelineId, pipeline.id), eq(sboms.serviceId, job.serviceId))).orderBy(desc(sboms.createdAt)).limit(1);
      if (own) subject.sbomId = own.id;
    }
    // the release of this commit, else the newest image built from it (by tag) — for the record and for image SBOMs
    const key = commitSha ?? ref;
    if (key && !version && job.serviceId) {
      const [rel] = await this.db.select({ version: releases.version }).from(releases).where(and(eq(releases.serviceId, job.serviceId), eq(releases.commitSha, key))).limit(1);
      if (rel) subject.version = rel.version;
      else if (!subject.sbomId) {
        const [t] = await this.db.select({ digest: imageTags.digest }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(and(eq(containerImages.serviceId, job.serviceId), eq(imageTags.tag, key))).orderBy(desc(imageTags.builtAt)).limit(1);
        if (t?.digest) subject.digest = t.digest;
      }
    }
    return this.evaluate(chain, subject, { actor: 'pipeline', jobId: job.id });
  }
}
