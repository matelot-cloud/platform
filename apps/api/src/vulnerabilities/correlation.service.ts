import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { DATABASE, Database } from '../database/database.module';
import { remediations, advisories, componentChecks, components, deployments, findings, findingSboms, imageTags, sbomComponents, sboms, Severity } from '../database/schema';
import { ADVISORY_SOURCE, AdvisorySource, OsvVulnerability } from './advisory-source';
import { cvss3BaseScore, fixedVersionFor, osvQueryFor, severityFromScore } from './osv-mapping';
import { canonicalAdvisoryId, decideSeverity, packageKeyOf } from './severity';
import { SnapshotsService } from './snapshots.service';
import { RiskService } from '../risk/risk.service';

/**
 * Correlates SBOM components with advisories and maintains findings.
 *
 *  1. Components not checked in the last 24 h are queried at OSV in batches; results cached per component.
 *  2. Unknown advisories are fetched and enriched (CVSS from vector, KEV, EPSS).
 *  3. Findings are upserted per service × component × advisory and linked to every SBOM containing the component;
 *     findings whose component no longer appears in any *current* SBOM of the service are closed as fixed.
 */
export interface CorrelationJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  options: { limit?: number; force?: boolean; serviceId?: string };
  /** Scope the job was requested through; reads are authorised against it. */
  organizationId: string | null;
  createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
  result: { checked: number; newAdvisories: number; findingsOpened: number; findingsFixed: number } | null;
  error: string | null;
  /** Jobs ahead of this one (0 = next). */
  position: number;
}

@Injectable()
export class CorrelationService {
  private readonly logger = new Logger(CorrelationService.name);
  /**
   * One worker, a FIFO of requests. Nothing is dropped: a request while a run is in progress is queued (deduplicated
   * per service/force), and callers get a job they can poll. Severity enrichment (alias / NVD lookups) runs on a
   * separate low-priority loop so it never holds the correlation worker.
   */
  private readonly queue: CorrelationJob[] = [];
  private current: CorrelationJob | null = null;
  private readonly jobs = new Map<string, CorrelationJob>();
  private enrichPending = new Set<string>();
  private enriching = false;

  onModuleInit() {
    // Retry safety: SBOMs still pending after 2 minutes (a lost run, a crash) are requested again.
    const t = setInterval(() => void this.requeuePendingSboms().catch((e: Error) => this.logger.warn(`requeue failed: ${e.message}`)), 30_000);
    t.unref?.();
  }

  async requeuePendingSboms(): Promise<number> {
    // pending for more than 2 minutes (lost run / crash), or failed and due for its backoff retry
    const rows = await this.db.select({ serviceId: sboms.serviceId }).from(sboms).where(or(
      and(eq(sboms.correlationStatus, 'pending'), or(lt(sboms.createdAt, new Date(Date.now() - 120_000)), lt(sboms.correlationNextRetryAt, new Date()))),
      and(eq(sboms.correlationStatus, 'failed'), or(isNull(sboms.correlationNextRetryAt), lt(sboms.correlationNextRetryAt, new Date()))),
    ));
    const ids = [...new Set(rows.map((r) => r.serviceId))];
    for (const id of ids) this.request({ serviceId: id });
    return ids.length;
  }

  /** Enqueue a run; returns the job (status queued/running/done). Same-scope queued requests are merged. */
  request(options: { limit?: number; force?: boolean; serviceId?: string } = {}, organizationId: string | null = null): CorrelationJob {
    const dup = [this.current, ...this.queue].find((j) => j && j.status === 'queued' && j.options.serviceId === options.serviceId && !!j.options.force === !!options.force);
    if (dup) return dup;
    const job: CorrelationJob = { id: randomUUID(), status: 'queued', options, organizationId, createdAt: new Date(), startedAt: null, finishedAt: null, result: null, error: null, position: this.queue.length + (this.current ? 1 : 0) };
    this.queue.push(job);
    this.jobs.set(job.id, job);
    if (this.jobs.size > 500) for (const [k, v] of this.jobs) { if (v.status === 'done' || v.status === 'failed') { this.jobs.delete(k); if (this.jobs.size <= 400) break; } }
    void this.drain();
    return job;
  }

  job(id: string): CorrelationJob | null { return this.jobs.get(id) ?? null; }

  /** Await a job's completion (used by the compatibility `run()` and tests). */
  async wait(job: CorrelationJob, timeoutMs = 10 * 60_000): Promise<CorrelationJob> {
    const until = Date.now() + timeoutMs;
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() > until) throw new Error('correlation job timed out');
      await new Promise((r) => setTimeout(r, 200));
    }
    return job;
  }

  private async drain(): Promise<void> {
    if (this.current) return;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      this.current = job;
      job.status = 'running'; job.startedAt = new Date();
      try {
        job.result = await this.execute(job.options);
        job.status = 'done';
      } catch (e) {
        job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e);
        this.logger.warn(`correlation job ${job.id} failed: ${job.error}`);
        // mark the service's unfinished SBOMs failed with an exponential backoff (1, 2, 4 … 60 min) before the next automatic retry
        if (job.options.serviceId) await this.db.execute(sql`update sboms set correlation_status = 'failed', correlation_error = ${job.error}, correlation_attempts = correlation_attempts + 1, correlation_next_retry_at = now() + least(power(2, correlation_attempts), 60) * interval '1 minute' where service_id = ${job.options.serviceId} and correlation_status in ('pending', 'failed')`).catch(() => undefined);
      } finally {
        job.finishedAt = new Date();
      }
      for (const q of this.queue) q.position = Math.max(0, q.position - 1);
    }
    this.current = null;
  }

  /** Compatibility: enqueue and wait. */
  async run(options: { limit?: number; force?: boolean; serviceId?: string } = {}): Promise<{ checked: number; newAdvisories: number; findingsOpened: number; findingsFixed: number }> {
    const job = await this.wait(this.request(options));
    if (job.status === 'failed') throw new Error(job.error ?? 'correlation failed');
    return job.result!;
  }

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ADVISORY_SOURCE) private readonly source: AdvisorySource,
    private readonly audit: AuditService,
    private readonly snapshots: SnapshotsService,
    @Optional() private readonly risk?: RiskService,
  ) {}

  /** One pass: check stale components (max `limit`), refresh findings for every service in scope — ALWAYS the requested service. */
  private async execute(options: { limit?: number; force?: boolean; serviceId?: string }): Promise<{ checked: number; newAdvisories: number; findingsOpened: number; findingsFixed: number }> {
    {
      const staleBefore = new Date(Date.now() - 24 * 3600_000);
      const scope = options.serviceId ? await this.componentIdsOfService(options.serviceId) : null;
      const rows = await this.db
        .select({ id: components.id, purl: components.purl })
        .from(components)
        .leftJoin(componentChecks, eq(componentChecks.componentId, components.id))
        .where(and(scope ? inArray(components.id, scope) : undefined, options.force ? undefined : or(isNull(componentChecks.checkedAt), lt(componentChecks.checkedAt, staleBefore))))
        .limit(options.limit ?? 2000);
      const queries = rows.map((r) => ({ id: r.id, purl: r.purl, q: osvQueryFor(r.purl) }));
      const askable = queries.filter((x) => x.q);
      let newAdvisories = 0;
      const results = askable.length ? await this.source.queryBatch(askable.map((x) => x.q!)) : [];
      const now = new Date();
      const touchedComponents = new Map<string, string[]>();
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const ids = q.q ? (results[askable.indexOf(q)] ?? []) : [];
        touchedComponents.set(q.id, ids);
      }
      // cache checks
      for (const [componentId, ids] of touchedComponents) {
        await this.db.insert(componentChecks).values({ componentId, checkedAt: now, advisoryIds: ids }).onConflictDoUpdate({ target: componentChecks.componentId, set: { checkedAt: now, advisoryIds: ids, error: null } });
      }
      // fetch unknown advisories
      const allIds = [...new Set([...touchedComponents.values()].flat())];
      // Fetch unknown advisories, and re-fetch those never decided by the current severity rules (severity_source null,
      // i.e. stored before migration 0031) or older than 7 days: otherwise recorrelate never applies new rules.
      const knownRows = allIds.length ? await this.db.select({ id: advisories.id, src: advisories.severitySource, at: advisories.fetchedAt }).from(advisories).where(inArray(advisories.id, allIds)) : [];
      const fresh = new Set(knownRows.filter((a) => a.src && a.at.getTime() > Date.now() - 7 * 86400_000).map((a) => a.id));
      const missing = allIds.filter((id) => !fresh.has(id)).slice(0, 2000);
      for (const id of missing) {
        const v = await this.source.vulnerability(id).catch((e: Error) => {
          this.logger.warn(`advisory ${id}: ${e.message}`);
          return null;
        });
        if (!v) continue;
        await this.upsertAdvisory(v);
        newAdvisories++;
      }
      if (missing.length) await this.enrich(missing);
      // findings for the services that own these components
      const serviceIds = options.serviceId ? [options.serviceId] : await this.servicesOfComponents([...touchedComponents.keys()]);
      let opened = 0;
      let fixed = 0;
      for (const serviceId of serviceIds) {
        const r = await this.refreshService(serviceId);
        opened += r.opened;
        fixed += r.fixed;
      }
      if (opened || fixed || queries.length) await this.snapshots.snapshotToday().catch((e: Error) => this.logger.warn(`snapshot failed: ${e.message}`));
      if (this.risk) for (const id of serviceIds) await this.risk.compute(id).catch((e: Error) => this.logger.warn(`risk for ${id}: ${e.message}`));
      // severity enrichment (alias / NVD) off the critical path
      this.scheduleEnrichment();
      return { checked: queries.length, newAdvisories, findingsOpened: opened, findingsFixed: fixed };
    }
  }

  // ---------------------------------------------------------------- background severity enrichment
  private scheduleEnrichment(): void {
    if (this.enriching) return;
    this.enriching = true;
    setTimeout(() => void this.enrichSeverities().catch((e: Error) => this.logger.warn(`severity enrichment failed: ${e.message}`)).finally(() => { this.enriching = false; }), 1_000).unref?.();
  }

  /**
   * Advisories with no CVSS of their own and no cached alias result: ask OSV for the CVE/GHSA alias, then NVD.
   * Results are cached on the advisory (alias_checked_at), each advisory is isolated, and findings are re-decided.
   */
  async enrichSeverities(batch = 50): Promise<number> {
    const rows = await this.db.select().from(advisories).where(and(isNull(advisories.cvssScore), isNull(advisories.aliasCheckedAt))).orderBy(advisories.fetchedAt).limit(batch);
    let done = 0;
    for (const adv of rows) {
      try {
        let aliasCvssScore: number | null = null; let aliasSource: 'nvd' | 'ghsa' | null = null; let aliasText: string | null = null;
        const ids = [...adv.aliases, ...(/^(?:DEBIAN-)?(CVE-\d{4}-\d+)$/i.exec(adv.id)?.[1] ? [/^(?:DEBIAN-)?(CVE-\d{4}-\d+)$/i.exec(adv.id)![1]!] : [])];
        for (const alias of [...ids.filter((x) => /^CVE-/i.test(x)), ...ids.filter((x) => /^GHSA-/i.test(x))].slice(0, 2)) {
          const a = await this.source.vulnerability(alias).catch(() => null);
          if (!a) continue;
          aliasText = aliasText ?? [a.summary, a.details].filter(Boolean).join('\n').slice(0, 4000);
          const av = a.severity?.find((x) => x.type.startsWith('CVSS_V3'))?.score ?? a.severity?.find((x) => x.type === 'CVSS_V4')?.score ?? null;
          const as = av ? cvss3BaseScore(av) : null;
          if (as !== null) { aliasCvssScore = as; aliasSource = /^GHSA-/i.test(alias) ? 'ghsa' : 'nvd'; break; }
        }
        const cve = ids.find((x) => /^CVE-/i.test(x)) ?? null;
        if (aliasCvssScore === null && cve && this.source.nvdCvss) {
          const n = await this.source.nvdCvss(cve).catch(() => null);
          if (n) { aliasCvssScore = n.score; aliasSource = 'nvd'; aliasText = aliasText ?? n.description; }
        }
        const decision = decideSeverity({ id: adv.id, summary: adv.summary, details: adv.details, cvssVector: adv.cvssVector, cvssScore: adv.cvssScore, databaseSeverity: adv.severitySource === 'database' ? adv.severity : null, affected: adv.affected, aliasCvssScore, aliasText });
        await this.db.update(advisories).set({ aliasCvssScore, aliasSource, aliasText, aliasCheckedAt: new Date(), severity: decision.severity, severitySource: decision.source, severityNote: decision.note }).where(eq(advisories.id, adv.id));
        if (aliasCvssScore !== null) {
          // re-decide every finding of this advisory with its component's own purl
          const fs = await this.db.select({ id: findings.id, purl: components.purl }).from(findings).innerJoin(components, eq(findings.componentId, components.id)).where(eq(findings.advisoryId, adv.id));
          for (const f of fs) {
            const d = decideSeverity({ id: adv.id, summary: adv.summary, details: adv.details, cvssVector: adv.cvssVector, cvssScore: adv.cvssScore, affected: adv.affected, aliasCvssScore, aliasText }, f.purl);
            await this.db.update(findings).set({ severity: d.severity, severitySource: d.source, severityNote: d.note }).where(eq(findings.id, f.id));
          }
        }
        done++;
      } catch (e) {
        this.logger.warn(`enrich ${adv.id}: ${e instanceof Error ? e.message : String(e)}`);
        await this.db.update(advisories).set({ aliasCheckedAt: new Date() }).where(eq(advisories.id, adv.id)).catch(() => undefined); // do not retry forever
      }
    }
    if (rows.length === batch) this.scheduleEnrichment();
    return done;
  }

  /** Daily enrichment refresh (KEV list, EPSS scores) for cached advisories. */
  async refreshEnrichment(): Promise<number> {
    const ids = (await this.db.select({ id: advisories.id }).from(advisories)).map((a) => a.id);
    if (!ids.length) return 0;
    await this.enrich(ids);
    return ids.length;
  }

  private async componentIdsOfService(serviceId: string): Promise<string[]> {
    const rows = await this.db.select({ id: sbomComponents.componentId }).from(sbomComponents).innerJoin(sboms, eq(sbomComponents.sbomId, sboms.id)).where(eq(sboms.serviceId, serviceId));
    return [...new Set(rows.map((r) => r.id))];
  }

  private async servicesOfComponents(componentIds: string[]): Promise<string[]> {
    if (!componentIds.length) return [];
    const rows = await this.db.selectDistinct({ id: sboms.serviceId }).from(sbomComponents).innerJoin(sboms, eq(sbomComponents.sbomId, sboms.id)).where(inArray(sbomComponents.componentId, componentIds));
    return rows.map((r) => r.id);
  }

  private async upsertAdvisory(v: OsvVulnerability): Promise<void> {
    const vector = v.severity?.find((s) => s.type.startsWith('CVSS_V3'))?.score ?? v.severity?.find((s) => s.type === 'CVSS_V4')?.score ?? null;
    const score = vector ? cvss3BaseScore(vector) : null;
    const dbSeverity = (v.database_specific?.severity ?? '').toLowerCase();

    // Alias / NVD scores are looked up by the background enrichment (enrichSeverities), not here: this must be fast.
    const [cached] = await this.db.select({ aliasCvssScore: advisories.aliasCvssScore, aliasSource: advisories.aliasSource, aliasText: advisories.aliasText }).from(advisories).where(eq(advisories.id, v.id)).limit(1);
    const aliasCvssScore = cached?.aliasCvssScore ?? null; const aliasSource = cached?.aliasSource ?? null; const aliasText = cached?.aliasText ?? null;
    // Severity: distribution rating → CVSS vector → database_specific.severity → alias CVSS → unknown (severity.ts).
    // cvssScore / cvssVector stay as they are: displayed, but they do not decide when the distribution rated it.
    const decision = decideSeverity({ id: v.id, summary: v.summary, details: v.details, cvssVector: vector, cvssScore: score, databaseSeverity: dbSeverity || null, affected: v.affected ?? [], aliasCvssScore, aliasText });
    const severity: Severity = decision.severity;
    const severitySource = decision.source;
    const severityNote = decision.note;
    await this.db
      .insert(advisories)
      .values({ id: v.id, aliases: v.aliases ?? [], summary: v.summary ?? null, details: v.details ?? null, severity, severitySource, severityNote, canonicalId: canonicalAdvisoryId(v.id, v.aliases, (v as { upstream?: string[] }).upstream), cvssScore: score, cvssVector: vector, aliasCvssScore, aliasSource, aliasText, publishedAt: v.published ? new Date(v.published) : null, modifiedAt: v.modified ? new Date(v.modified) : null, references: v.references ?? [], affected: v.affected ?? [], fetchedAt: new Date() })
      .onConflictDoUpdate({ target: advisories.id, set: { aliases: v.aliases ?? [], summary: v.summary ?? null, details: v.details ?? null, severity, severitySource, severityNote, canonicalId: canonicalAdvisoryId(v.id, v.aliases, (v as { upstream?: string[] }).upstream), cvssScore: score, cvssVector: vector, aliasCvssScore, aliasSource, aliasText, modifiedAt: v.modified ? new Date(v.modified) : null, references: v.references ?? [], affected: v.affected ?? [], fetchedAt: new Date() } });
  }

  /** KEV + EPSS by CVE alias. */
  private async enrich(ids: string[]): Promise<void> {
    const rows = await this.db.select({ id: advisories.id, aliases: advisories.aliases }).from(advisories).where(inArray(advisories.id, ids));
    const cveOf = (a: { id: string; aliases: string[] }) => [a.id, ...a.aliases].find((x) => /^CVE-\d{4}-\d+$/i.test(x))?.toUpperCase();
    const cves = [...new Set(rows.map(cveOf).filter((x): x is string => !!x))];
    const [kev, epss] = await Promise.all([this.source.kev().catch((e: Error) => (this.logger.warn(`KEV: ${e.message}`), new Map<string, { dueDate: string | null }>())), cves.length ? this.source.epss(cves).catch((e: Error) => (this.logger.warn(`EPSS: ${e.message}`), new Map<string, { score: number; percentile: number }>())) : new Map<string, { score: number; percentile: number }>()]);
    for (const a of rows) {
      const cve = cveOf(a);
      const k = cve ? kev.get(cve) : undefined;
      const e = cve ? epss.get(cve) : undefined;
      await this.db.update(advisories).set({ kev: !!k, kevDueDate: k?.dueDate ? new Date(k.dueDate) : null, ...(e ? { epssScore: e.score, epssPercentile: e.percentile } : {}) }).where(eq(advisories.id, a.id));
    }
  }

  /** Recomputes the findings of one service from the cached component checks. */
  /**
   * Remove a duplicate finding, re-pointing remediations that reference it to the kept one.
   * `remediations.finding_ids` is text[]: the rewrite is done in application code, no uuid casts.
   */
  async mergeFinding(duplicateId: string, keptId: string | null): Promise<void> {
    if (keptId) {
      const refs = await this.db.select({ id: remediations.id, findingIds: remediations.findingIds }).from(remediations).where(sql`${duplicateId} = any(${remediations.findingIds})`);
      for (const r of refs) {
        const ids = [...new Set(r.findingIds.map((x) => (x === duplicateId ? keptId : x)))];
        await this.db.update(remediations).set({ findingIds: ids }).where(eq(remediations.id, r.id));
      }
    }
    await this.db.delete(findings).where(eq(findings.id, duplicateId));
  }

  async refreshService(serviceId: string): Promise<{ opened: number; fixed: number }> {
    const [svc] = await this.db.select({ organizationId: sboms.organizationId }).from(sboms).where(eq(sboms.serviceId, serviceId)).limit(1);
    if (!svc) return { opened: 0, fixed: 0 };
    // Current SBOMs: latest per target (source / image) — what the service *is* now.
    const allSboms = await this.db.select({ id: sboms.id, target: sboms.target, createdAt: sboms.createdAt, releaseId: sboms.releaseId, imageTagId: sboms.imageTagId }).from(sboms).where(eq(sboms.serviceId, serviceId)).orderBy(desc(sboms.createdAt));
    if (!allSboms.length) return { opened: 0, fixed: 0 };
    // "Current" = the latest SBOM per target (what the service is now) plus SBOMs of releases / images deployed somewhere right now.
    const runningIds = new Set((await resolveRunningSboms(this.db, { serviceIds: [serviceId] })).map((r) => r.sbomId).filter((x): x is string => !!x));
    const currentIds = new Set<string>();
    const seenTarget = new Set<string>();
    for (const b of allSboms) {
      if (!seenTarget.has(b.target)) {
        seenTarget.add(b.target);
        currentIds.add(b.id);
      }
      if (runningIds.has(b.id)) currentIds.add(b.id);
    }
    const membership = await this.db.select({ sbomId: sbomComponents.sbomId, componentId: sbomComponents.componentId, purl: components.purl }).from(sbomComponents).innerJoin(components, eq(sbomComponents.componentId, components.id)).where(inArray(sbomComponents.sbomId, allSboms.map((b) => b.id)));
    const componentIds = [...new Set(membership.map((m) => m.componentId))];
    const checks = componentIds.length ? await this.db.select().from(componentChecks).where(inArray(componentChecks.componentId, componentIds)) : [];
    const advisoryIdsByComponent = new Map(checks.map((c) => [c.componentId, c.advisoryIds]));
    const involved = [...new Set(checks.flatMap((c) => c.advisoryIds))];
    const advisoryRows = involved.length ? await this.db.select().from(advisories).where(inArray(advisories.id, involved)) : [];
    const advisoryById = new Map(advisoryRows.map((a) => [a.id, a]));
    const purlOf = new Map(membership.map((m) => [m.componentId, m.purl]));
    const sbomsOfComponent = new Map<string, Set<string>>();
    for (const m of membership) {
      if (!sbomsOfComponent.has(m.componentId)) sbomsOfComponent.set(m.componentId, new Set());
      sbomsOfComponent.get(m.componentId)!.add(m.sbomId);
    }
    const existing = await this.db.select().from(findings).where(eq(findings.serviceId, serviceId));
    const existingKey = new Map(existing.map((f) => [`${f.componentId}:${f.advisoryId}`, f]));
    const createdThisRun = new Map<string, string>();
    const now = new Date();
    let opened = 0;
    let fixed = 0;
    const live = new Set<string>();
    for (const componentId of componentIds) {
      const inCurrent = [...(sbomsOfComponent.get(componentId) ?? [])].some((id) => currentIds.has(id));
      // One finding per (component, canonical vulnerability): GHSA-…, PYSEC-… and DEBIAN-CVE-… of one CVE are one finding.
      // The record kept is the one with the strongest rating (then the one already on file, then the lowest id).
      const RANK = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 } as const;
      const byCanonical = new Map<string, string[]>();
      for (const id of advisoryIdsByComponent.get(componentId) ?? []) { const a = advisoryById.get(id); if (!a) continue; const c = a.canonicalId ?? canonicalAdvisoryId(a.id, a.aliases); byCanonical.set(c, [...(byCanonical.get(c) ?? []), id]); }
      const chosen = new Set<string>();
      for (const [, ids] of byCanonical) {
        const pick = ids.sort((x, y) => (RANK[advisoryById.get(y)!.severity] - RANK[advisoryById.get(x)!.severity]) || (existingKey.has(`${componentId}:${y}`) ? 1 : 0) - (existingKey.has(`${componentId}:${x}`) ? 1 : 0) || x.localeCompare(y))[0]!;
        chosen.add(pick);
      }
      const dupIds = (advisoryIdsByComponent.get(componentId) ?? []).filter((id) => !chosen.has(id) && existingKey.has(`${componentId}:${id}`));
      for (const advisoryId of chosen) {
        const adv = advisoryById.get(advisoryId);
        if (!adv) continue;
        const key = `${componentId}:${advisoryId}`;
        const q = osvQueryFor(purlOf.get(componentId) ?? '');
        const fixedVersion = q ? fixedVersionFor(adv.affected, q.ecosystem, q.name, q.version) : null;
        const purl = purlOf.get(componentId) ?? '';
        // The finding follows the advisory, refined to the component's own distro suite (Debian:13 for +deb13uN).
        const decision = decideSeverity({ id: adv.id, summary: adv.summary, details: adv.details, cvssScore: adv.cvssScore, cvssVector: adv.cvssVector, databaseSeverity: adv.severitySource === 'database' ? adv.severity : null, affected: adv.affected, aliasCvssScore: adv.aliasCvssScore, aliasText: adv.aliasText }, purl);
        const sev = { severity: decision.severity, severitySource: decision.source, severityNote: decision.note, packageKey: packageKeyOf(purl), canonicalId: adv.canonicalId ?? canonicalAdvisoryId(adv.id, adv.aliases) };
        let finding = existingKey.get(key);
        if (!finding) {
          if (!inCurrent) continue; // historical only: no new finding for a version already gone
          [finding] = await this.db.insert(findings).values({ organizationId: svc.organizationId, serviceId, componentId, advisoryId, ...sev, fixedVersion, firstSeenAt: now, lastSeenAt: now }).onConflictDoNothing().returning();
          if (!finding) continue;
          createdThisRun.set(`${componentId}:${advisoryId}`, finding.id);
          opened++;
          await this.audit.record({ organizationId: svc.organizationId, actor: SYSTEM_ACTOR, action: 'finding.opened', resourceType: 'finding', resourceId: finding.id, after: { advisory: advisoryId, severity: decision.severity, severitySource: decision.source, component: purlOf.get(componentId) } });
        } else {
          const reopen = finding.status === 'fixed' && inCurrent;
          await this.db.update(findings).set({ ...sev, fixedVersion, lastSeenAt: inCurrent ? now : finding.lastSeenAt, ...(reopen ? { status: 'open', resolvedAt: null } : {}) }).where(eq(findings.id, finding.id));
          if (reopen) opened++;
        }
        live.add(finding.id);
        // link SBOMs containing it
        for (const sbomId of sbomsOfComponent.get(componentId) ?? []) await this.db.insert(findingSboms).values({ findingId: finding.id, sbomId }).onConflictDoNothing();
        // Gone from every current SBOM: open and accepted findings close as fixed (false positives / not affected keep their verdict).
        if (!inCurrent && (finding.status === 'open' || finding.status === 'accepted')) {
          await this.db.update(findings).set({ status: 'fixed', resolvedAt: now }).where(eq(findings.id, finding.id));
          fixed++;
        }
      }
      // duplicates of a chosen record on this component: fold into the kept finding (remediations re-pointed), then delete.
      // Bookkeeping only: any failure here is logged and must never abort the run (the SBOM has to reach `done`).
      for (const id of dupIds) {
        const dup = existingKey.get(`${componentId}:${id}`);
        if (!dup) continue;
        const keptId = [...chosen].map((c) => existingKey.get(`${componentId}:${c}`)?.id ?? createdThisRun.get(`${componentId}:${c}`) ?? null).find(Boolean) ?? null;
        try {
          await this.mergeFinding(dup.id, keptId);
          existingKey.delete(`${componentId}:${id}`);
          await this.audit.record({ organizationId: svc.organizationId, actor: SYSTEM_ACTOR, action: 'finding.merged', resourceType: 'finding', resourceId: dup.id, after: { advisory: id, mergedInto: keptId, reason: 'same CVE as another record on this component' } }).catch(() => undefined);
        } catch (e) {
          this.logger.warn(`merge of duplicate finding ${dup.id} (advisory ${id}) into ${keptId ?? 'none'} failed, left in place: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // findings whose component/advisory pair is no longer reported at all → fixed
    for (const f of existing) {
      if (live.has(f.id) || (f.status !== 'open' && f.status !== 'accepted')) continue;
      const stillPresent = [...(sbomsOfComponent.get(f.componentId) ?? [])].some((id) => currentIds.has(id)) && (advisoryIdsByComponent.get(f.componentId) ?? []).includes(f.advisoryId);
      if (!stillPresent) {
        await this.db.update(findings).set({ status: 'fixed', resolvedAt: now }).where(eq(findings.id, f.id));
        fixed++;
      }
    }
    await this.db.update(sboms).set({ correlationStatus: 'done', correlatedAt: new Date(), correlationError: null, correlationAttempts: 0, correlationNextRetryAt: null }).where(and(eq(sboms.serviceId, serviceId), inArray(sboms.correlationStatus, ['pending', 'failed'])));
    // "running": the finding is in an SBOM that a current deployment runs (same resolver as every view).
    const runningSbomIds = [...new Set((await resolveRunningSboms(this.db, { serviceIds: [serviceId] })).map((r) => r.sbomId).filter((x): x is string => !!x))];
    const runningFindingIds = runningSbomIds.length ? (await this.db.select({ id: findingSboms.findingId }).from(findingSboms).where(inArray(findingSboms.sbomId, runningSbomIds))).map((r) => r.id) : [];
    await this.db.update(findings).set({ running: false }).where(and(eq(findings.serviceId, serviceId), runningFindingIds.length ? notInArray(findings.id, runningFindingIds) : sql`true`));
    if (runningFindingIds.length) await this.db.update(findings).set({ running: true }).where(and(eq(findings.serviceId, serviceId), inArray(findings.id, runningFindingIds)));
    return { opened, fixed };
  }
}
