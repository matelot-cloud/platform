/** `matelot service show`: the service, its latest pipeline and the open findings on a few lines (GET /services/:id/summary). */
export interface ServiceSummary {
  id: string; slug: string; name: string; kind?: string | null; criticality?: string | null; projectId: string;
  latestPipeline: { id: string; number: number; status: string; ref?: string | null; commitSha?: string | null; createdAt: string; finishedAt?: string | null; jobs: { name: string; status: string; error?: string | null }[] } | null;
  findings: { open: { critical: number; high: number; medium: number; low: number; unknown: number; total: number }; kev: number };
  codeFindings: { open: { secret: number; iac: number; sast: number } };
  latestSbom: { id: string; target: string; targetRef: string; componentCount: number; createdAt: string } | null;
}

export function serviceText(s: ServiceSummary): string {
  const lines = [`${s.name} (${s.slug}${s.kind ? `, ${s.kind}` : ''}${s.criticality ? `, ${s.criticality} criticality` : ''})  id ${s.id}`];
  const p = s.latestPipeline;
  if (p) {
    const when = p.finishedAt ?? p.createdAt;
    const bad = p.jobs.filter((j) => ['failed', 'timed_out'].includes(j.status));
    lines.push(`pipeline #${p.number}: ${p.status}${p.ref ? ` on ${p.ref}` : ''}${p.commitSha ? ` @ ${p.commitSha.slice(0, 7)}` : ''} (${when.slice(0, 16).replace('T', ' ')}) — ${p.jobs.map((j) => `${j.name} ${j.status}`).join(', ')}${bad.length ? `\n  ${bad.map((j) => `${j.name}: ${j.error ?? 'failed'}`).join('\n  ')}` : ''}`);
  } else lines.push('pipeline: none yet');
  const o = s.findings.open;
  lines.push(`open findings: ${o.total} (${o.critical} critical, ${o.high} high, ${o.medium} medium, ${o.low} low${o.unknown ? `, ${o.unknown} unknown` : ''})${s.findings.kev ? ` · ${s.findings.kev} known-exploited` : ''}`);
  const c = s.codeFindings.open;
  lines.push(`open code findings: ${c.secret} secrets, ${c.iac} infrastructure, ${c.sast} code`);
  lines.push(s.latestSbom ? `latest SBOM: ${s.latestSbom.target} ${s.latestSbom.targetRef} — ${s.latestSbom.componentCount} components (${s.latestSbom.createdAt.slice(0, 10)})` : 'latest SBOM: none');
  return lines.join('\n');
}
