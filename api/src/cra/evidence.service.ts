import { releaseImage, releaseSbomIds } from '../sbom/running-sbom';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createHash, createHmac } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { advisories, codeFindings, components, containerImages, deployments, environments, exceptions, findings, findingSboms, gateEvaluations, imageTags, policies, projects, releases, riskScores, sboms, services } from '../database/schema';
import { PoliciesService } from '../policies/policies.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { SbomService } from '../sbom/sbom.service';
import { buildZip } from './zip';
import { buildOpenVex } from './vex';

/**
 * Evidence bundle for a release: what shipped (SBOMs, images, digests), what was known (findings, KEV/EPSS),
 * what was decided (statuses, exceptions), what was enforced (gate evaluations, policies), where it ran
 * (deployments) — as JSON + a human-readable summary, with signed checksums.
 */
type Loc = { image: string; tag: string | null; digest: string | null; builtAt: Date | null; source: 'tag' | 'deployment' };
export function releaseLocations(twins: { tag: { tag: string; digest: string | null; builtAt: Date | null }; image: { name: string } }[], deps: { d: { imageRef: string | null } }[], digests: string[]): Loc[] {
  const out: Loc[] = twins.map((t) => ({ image: t.image.name, tag: t.tag.tag, digest: t.tag.digest, builtAt: t.tag.builtAt, source: 'tag' }));
  for (const x of deps) {
    const ref = x.d.imageRef?.toLowerCase();
    if (!ref || !digests.some((d) => ref.endsWith(`@${d}`))) continue;
    const repo = ref.split('@')[0]!.replace(/:[^/:]+$/, '');
    if (!out.some((o) => o.image.toLowerCase() === repo)) out.push({ image: repo, tag: null, digest: ref.split('@')[1]!, builtAt: null, source: 'deployment' });
  }
  return out;
}

@Injectable()
export class EvidenceService {
  private readonly signingKey: Buffer;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ConfigService) config: AppConfig,
    private readonly sbom: SbomService,
    private readonly policiesService: PoliciesService,
    private readonly resolver: ScopeResolverService,
    private readonly audit: AuditService,
  ) {
    // Evidence signing key derived from the cell key (never the key itself).
    this.signingKey = createHmac('sha256', Buffer.from(String(config.get('CELL_ENCRYPTION_KEY', { infer: true }) ?? '0'.repeat(64)), 'hex')).update('matelot-evidence-v1').digest();
  }

  async summary(releaseId: string) {
    const [row] = await this.db.select({ release: releases, service: services, project: projects }).from(releases).innerJoin(services, eq(releases.serviceId, services.id)).innerJoin(projects, eq(services.projectId, projects.id)).where(eq(releases.id, releaseId)).limit(1);
    if (!row) throw new NotFoundException('Release not found');
    const { release, service, project } = row;
    const tags = await this.db.select({ tag: imageTags, image: containerImages }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(eq(imageTags.releaseId, releaseId));
    const tagIds = tags.map((t) => t.tag.id);
    // What the release IS: the digest(s) its deployments recorded (production first), never "whatever a tag points to now".
    const rel = await releaseImage(this.db, releaseId);
    const digests = rel.digests;
    // Every tag (any registry) currently carrying one of those digests describes the same image.
    const twins = digests.length ? await this.db.select({ tag: imageTags, image: containerImages }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(and(eq(containerImages.serviceId, service.id), inArray(imageTags.digest, digests))) : [];
    // SBOMs: the release's source SBOM + image SBOMs whose image_digest is the release digest (a tag that moved brings nothing).
    const relSbomIds = await releaseSbomIds(this.db, service.id, releaseId, digests);
    const sbomRows = relSbomIds.length ? await this.db.select().from(sboms).where(inArray(sboms.id, relSbomIds)) : [];
    const sbomIds = sbomRows.map((b) => b.id);
    const links = sbomIds.length ? await this.db.select({ findingId: findingSboms.findingId, sbomId: findingSboms.sbomId }).from(findingSboms).where(inArray(findingSboms.sbomId, sbomIds)) : [];
    const findingIds = [...new Set(links.map((l) => l.findingId))];
    const findingRows = findingIds.length ? await this.db.select({ f: findings, adv: advisories, comp: components }).from(findings).innerJoin(advisories, eq(findings.advisoryId, advisories.id)).innerJoin(components, eq(findings.componentId, components.id)).where(inArray(findings.id, findingIds)) : [];
    const codeRows = await this.db.select().from(codeFindings).where(eq(codeFindings.serviceId, service.id));
    const exRows = await this.db.select().from(exceptions).where(eq(exceptions.organizationId, release.organizationId)).then((rows) => rows.filter((e) => (e.appliedFindingIds.some((id) => findingIds.includes(id)) || e.appliedCodeFindingIds.some((id) => codeRows.some((c) => c.id === id)))));
    const deps = await this.db.select({ d: deployments, env: environments }).from(deployments).innerJoin(environments, eq(deployments.environmentId, environments.id)).where(eq(deployments.releaseId, releaseId)).orderBy(desc(deployments.deployedAt));
    const gates = await this.db.select().from(gateEvaluations).where(eq(gateEvaluations.serviceId, service.id)).orderBy(desc(gateEvaluations.evaluatedAt)).then((rows) => rows.filter((g) => g.subject.version === release.version || (g.subject.digest && digests.includes(g.subject.digest)) || (g.subject.sbomId && sbomIds.includes(g.subject.sbomId))).slice(0, 50));
    const chain = await this.resolver.resolveChain({ serviceId: service.id });
    const pols = await this.policiesService.applicable(chain);
    const [risk] = await this.db.select().from(riskScores).where(eq(riskScores.serviceId, service.id)).orderBy(desc(riskScores.computedAt)).limit(1);
    const openBySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } as Record<string, number>;
    let kevOpen = 0;
    for (const r of findingRows) if (r.f.status === 'open') { openBySeverity[r.f.severity]++; if (r.adv.kev) kevOpen++; }
    return {
      generatedAt: new Date().toISOString(),
      product: { organizationId: release.organizationId, project: { id: project.id, name: project.name, slug: project.slug }, service: { id: service.id, name: service.name, slug: service.slug, criticality: service.criticality } },
      release: { id: release.id, version: release.version, tag: release.tag, commitSha: release.commitSha, source: release.source, releasedAt: release.releasedAt, htmlUrl: release.htmlUrl, notes: release.notes },
      // Every registry location of the release digest: tags carrying it (any registry), plus where deployments ran it
      // from (a registry whose tag digest is not synced yet still appears, by its deployment imageRef).
      images: releaseLocations(twins, deps, digests),
      digests,
      productRef: rel.productRef,
      fixedSincePrevious: await this.fixedSincePrevious(release, findingRows.map((r) => ({ advisoryId: r.adv.canonicalId ?? r.adv.id, packageKey: r.f.packageKey, componentId: r.f.componentId }))),
      correlation: { status: sbomRows.length === 0 ? 'none' as const : sbomRows.every((b) => b.correlationStatus === 'done') ? 'done' as const : sbomRows.some((b) => b.correlationStatus === 'failed') ? 'failed' as const : 'pending' as const, sboms: sbomRows.map((b) => ({ id: b.id, status: b.correlationStatus, error: b.correlationError })) },
      sboms: sbomRows.map((b) => ({ id: b.id, target: b.target, targetRef: b.targetRef, format: b.format, componentCount: b.componentCount, digest: b.digest, createdAt: b.createdAt })),
      findings: findingRows.map((r) => ({ id: r.f.id, versionStatus: r.f.status === 'fixed' ? 'affected (fixed in a later build)' : 'affected', advisory: r.adv.canonicalId ?? r.adv.id, record: r.adv.id, aliases: [...new Set([r.adv.id, ...r.adv.aliases])].filter((a) => a !== (r.adv.canonicalId ?? r.adv.id)), severity: r.f.severity, cvss: r.adv.cvssScore, epss: r.adv.epssScore, kev: r.adv.kev, component: `${r.comp.name}@${r.comp.version}`, purl: r.comp.purl, fixedVersion: r.f.fixedVersion, status: r.f.status, note: r.f.note, firstSeenAt: r.f.firstSeenAt, statusChangedAt: r.f.statusChangedAt, summary: r.adv.summary })),
      codeFindings: codeRows.map((c) => ({ id: c.id, kind: c.kind, ruleId: c.ruleId, title: c.title, severity: c.severity, file: c.file, line: c.startLine, status: c.status, note: (c as { note?: string | null }).note ?? null, firstSeenAt: c.firstSeenAt })),
      exceptions: exRows.map((e) => ({ id: e.id, kind: e.kind, match: e.matchId, component: e.matchComponent, status: e.status, reason: e.reason, ticketUrl: e.ticketUrl, approvedAt: e.approvedAt, expiresAt: e.expiresAt, revokedAt: e.revokedAt, expiredAt: e.expiredAt })),
      gateEvaluations: gates.map((g) => ({ id: g.id, result: g.result, subject: g.subject, violations: g.violations, actor: g.actor, evaluatedAt: g.evaluatedAt })),
      deployments: deps.map((x) => ({ environment: x.env.name, kind: x.env.kind, internetFacing: x.env.internetFacing, version: x.d.version, imageRef: x.d.imageRef, source: x.d.source, deployedAt: x.d.deployedAt, supersededAt: x.d.supersededAt })),
      policies: pols.map((p) => ({ id: p.id, name: p.name, action: p.action, environmentKinds: p.environmentKinds, rules: p.rules })),
      risk: risk ? { score: risk.score, grade: risk.grade, computedAt: risk.computedAt } : null,
      totals: { findings: findingRows.length, open: openBySeverity, kevOpen, decisions: findingRows.filter((r) => ['accepted', 'false_positive', 'not_affected'].includes(r.f.status)).length, fixed: findingRows.filter((r) => r.f.status === 'fixed').length, codeFindingsOpen: codeRows.filter((c) => c.status === 'open').length },
    };
  }

  /** OpenVEX document for a release: every finding of the release's images with its decision. */
  async vex(releaseId: string) {
    const s = await this.summary(releaseId);
    // One product: the release digest, named after the production repository (else the service), no mutable tag.
    const name = (s.productRef ?? s.product.service.slug).split('/').slice(-1)[0];
    const products = s.digests.slice(0, 1).map((d) => ({ purl: `pkg:oci/${name}@${d}${s.productRef ? `?repository_url=${encodeURIComponent(s.productRef)}` : ''}`, identifiers: { purl: `pkg:oci/${name}@${d}` } }));
    // Findings linked to this release's SBOM are affected in THIS version whatever the service-level status says now:
    // a service-level `fixed` only means a later build no longer contains the component.
    const current = s.findings.map((f) => ({ advisory: f.advisory, aliases: f.aliases ?? [], component: f.component, purl: f.purl ?? null, status: (f.status === 'fixed' ? 'fixed_later' : f.status) as 'open' | 'accepted' | 'false_positive' | 'not_affected' | 'fixed_later', note: f.status === 'fixed' ? `present in ${s.release.version}; no longer present at service level${f.statusChangedAt ? ` since ${new Date(f.statusChangedAt).toISOString().slice(0, 10)}` : ''}` : f.note ?? null, fixedVersion: f.fixedVersion ?? null, statusChangedAt: f.statusChangedAt ? new Date(f.statusChangedAt).toISOString() : null }));
    // "fixed" only for what the PREVIOUS release of this product contained and this one no longer does.
    const fixed = s.fixedSincePrevious.map((f) => ({ advisory: f.advisory, aliases: f.aliases, component: f.component, purl: f.purl, status: 'fixed' as const, note: `present in ${f.previousVersion}, not in ${s.release.version}`, fixedVersion: f.fixedVersion, statusChangedAt: null }));
    return buildOpenVex({ author: `${s.product.project.name} / ${s.product.service.name} (Matelot)`, product: products.length ? products : [{ purl: `pkg:generic/${s.product.service.slug}@${s.release.version}` }], timestamp: s.generatedAt, findings: [...current, ...fixed] });
  }

  /** Findings of the previous release (by release date) whose (advisory, source package) is absent from this release. */
  private async fixedSincePrevious(release: typeof releases.$inferSelect, currentKeys: { advisoryId: string; packageKey: string | null; componentId: string }[]) {
    const [prev] = await this.db.select().from(releases).where(and(eq(releases.serviceId, release.serviceId), sql`${releases.id} <> ${release.id}`, sql`coalesce(${releases.releasedAt}, ${releases.createdAt}) < coalesce(${release.releasedAt ?? release.createdAt}::timestamptz, now())`)).orderBy(desc(sql`coalesce(${releases.releasedAt}, ${releases.createdAt})`)).limit(1);
    if (!prev) return [];
    const prevImage = await releaseImage(this.db, prev.id);
    const ids = await releaseSbomIds(this.db, release.serviceId, prev.id, prevImage.digests);
    if (!ids.length) return [];
    const rows = await this.db.select({ f: findings, adv: advisories, comp: components }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).innerJoin(advisories, eq(findings.advisoryId, advisories.id)).innerJoin(components, eq(findings.componentId, components.id)).where(inArray(findingSboms.sbomId, ids));
    const key = (a: string, k: string | null, c: string) => `${a}|${k ?? c}`;
    const now = new Set(currentKeys.map((c) => key(c.advisoryId, c.packageKey, c.componentId)));
    const canon = (adv: { id: string; canonicalId: string | null }) => adv.canonicalId ?? adv.id;
    const seen = new Set<string>();
    return rows.filter((r) => { const k = `${key(canon(r.adv), r.f.packageKey, r.f.componentId)}|${r.comp.purl}`; if (now.has(key(canon(r.adv), r.f.packageKey, r.f.componentId)) || seen.has(k)) return false; seen.add(k); return true; })
      .map((r) => ({ advisory: r.adv.canonicalId ?? r.adv.id, aliases: [...new Set([r.adv.id, ...r.adv.aliases])].filter((a) => a !== (r.adv.canonicalId ?? r.adv.id)), component: `${r.comp.name}@${r.comp.version}`, purl: r.comp.purl, fixedVersion: r.f.fixedVersion, previousVersion: prev.version }));
  }

  private markdown(s: Awaited<ReturnType<EvidenceService['summary']>>): string {
    const L: string[] = [];
    L.push(`# Evidence — ${s.product.service.name} ${s.release.version}`, '', `Generated ${s.generatedAt} by Matelot. Product: **${s.product.project.name} / ${s.product.service.name}** (criticality ${s.product.service.criticality ?? 'n/a'}).`, '');
    L.push('## Release', '', `- Version: **${s.release.version}**${s.release.tag ? ` (tag ${s.release.tag})` : ''}`, `- Commit: ${s.release.commitSha ?? 'unknown'}`, `- Source: ${s.release.source}${s.release.releasedAt ? ` · released ${new Date(s.release.releasedAt).toISOString()}` : ''}`, s.release.htmlUrl ? `- ${s.release.htmlUrl}` : '', '');
    L.push('## Images (what shipped)', '', ...(s.images.length ? s.images.map((i) => `- \`${i.image}${i.tag ? `:${i.tag}` : ''}\` · digest \`${i.digest ?? 'unknown'}\`${i.source === 'deployment' ? ' (from deployment)' : ''}`) : ['- none recorded']), '');
    L.push('## SBOMs', '', ...(s.sboms.length ? s.sboms.map((b) => `- ${b.target} \`${b.targetRef}\` · ${b.componentCount} components · ${b.format} · sha256 ${b.digest} (file: sboms/${b.id}.cdx.json)`) : ['- none']), '');
    L.push('## Vulnerabilities', '', `Total ${s.totals.findings} · open: critical ${s.totals.open.critical}, high ${s.totals.open.high}, medium ${s.totals.open.medium}, low ${s.totals.open.low} · known-exploited open: ${s.totals.kevOpen} · decided (accepted / false positive / not affected): ${s.totals.decisions} · fixed: ${s.totals.fixed}`, '');
    if (s.findings.length) { L.push('| Advisory | Severity | Component | Fix | Status | Note |', '|---|---|---|---|---|---|'); for (const f of s.findings.sort((a, b) => a.status.localeCompare(b.status) || a.severity.localeCompare(b.severity))) L.push(`| ${f.advisory}${f.kev ? ' (KEV)' : ''} | ${f.severity} | ${f.component} | ${f.fixedVersion ?? '—'} | ${f.status} | ${(f.note ?? '').replace(/\|/g, '/').slice(0, 80)} |`); L.push(''); }
    L.push('## Code findings (secrets, IaC)', '', ...(s.codeFindings.length ? ['| Rule | Kind | Severity | File | Status |', '|---|---|---|---|---|', ...s.codeFindings.map((c) => `| ${c.ruleId} | ${c.kind} | ${c.severity} | ${c.file}${c.line ? `:${c.line}` : ''} | ${c.status} |`)] : ['- none']), '');
    L.push('## Exceptions (time-boxed decisions)', '', ...(s.exceptions.length ? s.exceptions.map((e) => `- ${e.match}${e.component ? ` (${e.component})` : ''} → ${e.status} until ${new Date(e.expiresAt).toISOString().slice(0, 10)}${e.revokedAt ? ' (revoked)' : e.expiredAt ? ' (expired)' : ''} — ${e.reason}${e.ticketUrl ? ` (${e.ticketUrl})` : ''}`) : ['- none']), '');
    L.push('## Policy gate', '', ...(s.gateEvaluations.length ? s.gateEvaluations.slice(0, 10).map((g) => `- ${new Date(g.evaluatedAt).toISOString()} · **${g.result.toUpperCase()}** · ${g.subject.version ?? g.subject.imageRef ?? g.subject.ref ?? ''}${g.actor ? ` · by ${g.actor}` : ''}${g.violations.length ? `\n  - ${g.violations.map((v) => `${v.policyName}: ${v.message}`).join('\n  - ')}` : ''}`) : ['- no evaluation recorded for this release']), '', 'Policies in force:', '', ...(s.policies.length ? s.policies.map((p) => `- ${p.name} (${p.action}${p.environmentKinds.length ? `, ${p.environmentKinds.join('/')}` : ''}): max severity ${p.rules.maxSeverity ?? 'none'}, KEV ${p.rules.blockKev ? 'blocked' : 'allowed'}, secrets ${p.rules.blockSecrets ? 'blocked' : 'allowed'}, SBOM ${p.rules.requireSbom ? 'required' : 'optional'}`) : ['- none']), '');
    L.push('## Deployments', '', ...(s.deployments.length ? s.deployments.map((d) => `- ${new Date(d.deployedAt).toISOString()} · ${d.environment} (${d.kind}${d.internetFacing ? ', internet-facing' : ''}) · ${d.imageRef ?? d.version ?? ''} · via ${d.source}${d.supersededAt ? ` · superseded ${new Date(d.supersededAt).toISOString()}` : ' · current'}`) : ['- never deployed']), '');
    if (s.risk) L.push('## Risk', '', `Score ${s.risk.score} (grade ${s.risk.grade}) computed ${new Date(s.risk.computedAt).toISOString()}.`, '');
    L.push('## VEX', '', '`vex.openvex.json` states, per vulnerability and shipped image, whether the product is affected, not affected (with justification), fixed, or under investigation — the decisions above in machine-readable form (OpenVEX 0.2.0).', '');
    L.push('---', '`checksums.txt` lists the SHA-256 of every file in this bundle; `checksums.sig` is an HMAC-SHA256 over it made by the Matelot cell that produced the bundle. Verify with `matelot evidence verify <bundle.zip>` on the same cell.');
    return L.join('\n');
  }

  async bundle(user: AuthenticatedUser | null, releaseId: string): Promise<{ filename: string; data: Buffer; summary: Awaited<ReturnType<EvidenceService['summary']>> }> {
    const s = await this.summary(releaseId);
    const files: { name: string; data: Buffer | string }[] = [];
    files.push({ name: 'manifest.json', data: JSON.stringify({ format: 'matelot-evidence/1', generatedAt: s.generatedAt, product: s.product, release: s.release, images: s.images, sboms: s.sboms.map((b) => ({ ...b, file: `sboms/${b.id}.cdx.json` })), totals: s.totals, risk: s.risk }, null, 2) });
    files.push({ name: 'findings.json', data: JSON.stringify({ findings: s.findings, codeFindings: s.codeFindings, exceptions: s.exceptions }, null, 2) });
    files.push({ name: 'gate.json', data: JSON.stringify({ policies: s.policies, evaluations: s.gateEvaluations }, null, 2) });
    files.push({ name: 'deployments.json', data: JSON.stringify(s.deployments, null, 2) });
    for (const b of s.sboms) files.push({ name: `sboms/${b.id}.cdx.json`, data: await this.sbom.raw(b.id).catch(() => Buffer.from('{}')) });
    files.push({ name: 'vex.openvex.json', data: JSON.stringify(await this.vex(releaseId), null, 2) });
    files.push({ name: 'evidence.md', data: this.markdown(s) });
    const checksums = files.map((f) => `${createHash('sha256').update(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)).digest('hex')}  ${f.name}`).join('\n') + '\n';
    files.push({ name: 'checksums.txt', data: checksums });
    files.push({ name: 'checksums.sig', data: `hmac-sha256 ${createHmac('sha256', this.signingKey).update(checksums).digest('hex')}\n` });
    const data = buildZip(files);
    const filename = `evidence-${s.product.service.slug}-${s.release.version}.zip`;
    await this.audit.record({ organizationId: s.product.organizationId, actor: user ? userActor(user) : { type: 'SYSTEM', id: 'evidence', label: 'evidence export' }, action: 'evidence.exported', resourceType: 'release', resourceId: releaseId, after: { filename, files: files.length, findings: s.totals.findings, sha256: createHash('sha256').update(data).digest('hex') } });
    return { filename, data, summary: s };
  }

  /** Verifies a bundle produced by this cell: file checksums and the signature. */
  verify(checksums: string, signature: string, fileHashes: Record<string, string>): { signatureValid: boolean; files: { name: string; ok: boolean }[] } {
    const expected = `hmac-sha256 ${createHmac('sha256', this.signingKey).update(checksums).digest('hex')}`;
    const files = checksums.trim().split('\n').filter(Boolean).map((line) => { const [hash, ...rest] = line.split(/\s+/); const name = rest.join(' '); return { name, ok: fileHashes[name] === hash }; });
    return { signatureValid: signature.trim() === expected, files };
  }
}
