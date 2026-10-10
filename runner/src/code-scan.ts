import { createHash } from 'node:crypto';

/** Normalised code finding sent to the cell (never contains a secret value in clear). */
export interface CodeFindingInput {
  kind: 'secret' | 'iac' | 'sast';
  ruleId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  file: string;
  startLine: number | null;
  endLine: number | null;
  /** Redacted evidence (e.g. "AWS_SECRET_ACCESS_KEY=****…"), or the misconfiguration message. */
  evidence: string | null;
  resolution: string | null;
  references: string[];
  /** Stable identity across scans: kind + rule + file + (hash of the matched line / cause). */
  fingerprint: string;
  category: string | null;
}

const sev = (s: string | undefined): CodeFindingInput['severity'] => {
  const v = (s ?? '').toLowerCase();
  return v === 'critical' || v === 'high' || v === 'medium' || v === 'low' ? v : 'unknown';
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

interface TrivySecret { RuleID: string; Category?: string; Severity?: string; Title?: string; StartLine?: number; EndLine?: number; Match?: string }
interface TrivyMisconf { Type?: string; ID?: string; AVDID?: string; Title?: string; Description?: string; Message?: string; Resolution?: string; Severity?: string; PrimaryURL?: string; References?: string[]; Status?: string; CauseMetadata?: { StartLine?: number; EndLine?: number; Code?: { Lines?: { Number: number; Content: string; IsCause?: boolean }[] } } }
interface TrivyReport { Results?: { Target: string; Class?: string; Type?: string; Secrets?: TrivySecret[]; Misconfigurations?: TrivyMisconf[] }[] }

/** Redacts anything that could still be a secret: keep the key/prefix, mask the value. */
export function redact(match: string): string {
  const trimmed = match.trim().slice(0, 200);
  // Trivy already masks with '*'; mask again long high-entropy runs defensively.
  return trimmed.replace(/([A-Za-z0-9+/_\-]{6})[A-Za-z0-9+/=_\-]{10,}/g, '$1****');
}

export function parseTrivy(report: TrivyReport): CodeFindingInput[] {
  const out: CodeFindingInput[] = [];
  for (const r of report.Results ?? []) {
    for (const s of r.Secrets ?? []) {
      const evidence = s.Match ? redact(s.Match) : null;
      out.push({ kind: 'secret', ruleId: s.RuleID, title: s.Title ?? s.RuleID, severity: sev(s.Severity), file: r.Target, startLine: s.StartLine ?? null, endLine: s.EndLine ?? null, evidence, resolution: 'Revoke/rotate the credential, remove it from the repository history, and load it from a secret store at runtime.', references: [], fingerprint: hash(`secret|${s.RuleID}|${r.Target}|${(s.Match ?? '').replace(/\*/g, '')}`), category: s.Category ?? null });
    }
    for (const m of r.Misconfigurations ?? []) {
      if (m.Status && m.Status !== 'FAIL') continue;
      const cause = m.CauseMetadata?.Code?.Lines?.filter((l) => l.IsCause).map((l) => l.Content.trim()).join('\n') ?? '';
      const ruleId = m.AVDID ?? m.ID ?? 'unknown';
      out.push({ kind: 'iac', ruleId, title: m.Title ?? ruleId, severity: sev(m.Severity), file: r.Target, startLine: m.CauseMetadata?.StartLine ?? null, endLine: m.CauseMetadata?.EndLine ?? null, evidence: m.Message ?? null, resolution: m.Resolution ?? null, references: [m.PrimaryURL, ...(m.References ?? [])].filter((x): x is string => !!x).slice(0, 5), fingerprint: hash(`iac|${ruleId}|${r.Target}|${cause || m.Message || ''}`), category: m.Type ?? r.Type ?? null });
    }
  }
  return out;
}

/** Semgrep JSON (`semgrep scan --json`). */
export interface SemgrepReport { results?: { check_id: string; path: string; start?: { line?: number }; end?: { line?: number }; extra?: { message?: string; severity?: string; lines?: string; fix?: string; metadata?: { cwe?: string | string[]; owasp?: string | string[]; references?: string[]; category?: string; confidence?: string; impact?: string; likelihood?: string; 'security-severity'?: string; subcategory?: string[] } } }[]; errors?: { message?: string }[] }

const semgrepSeverity = (r: NonNullable<SemgrepReport['results']>[number]): CodeFindingInput['severity'] => {
  // Prefer the rule's security-severity (CVSS-like) or impact; fall back to Semgrep's ERROR/WARNING/INFO.
  const meta = r.extra?.metadata ?? {};
  const score = Number(meta['security-severity']);
  if (Number.isFinite(score) && score > 0) return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  const impact = String(meta.impact ?? '').toUpperCase();
  if (impact === 'HIGH') return 'high'; if (impact === 'MEDIUM') return 'medium'; if (impact === 'LOW') return 'low';
  const s = String(r.extra?.severity ?? '').toUpperCase();
  return s === 'ERROR' ? 'high' : s === 'WARNING' ? 'medium' : s === 'INFO' ? 'low' : 'unknown';
};

/** Cut at a word boundary with an ellipsis, never mid-word. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}
/** Semgrep's autofix is the raw replacement (e.g. "False"): show it in the context of the matched line, or omit. */
export function suggestedFix(fix: string | undefined, lines: string | undefined): string | null {
  if (!fix) return null;
  const line = (lines ?? '').trim().split('\n')[0] ?? '';
  const f = fix.trim();
  if (!f) return null;
  if (line && f.length < line.length && line.includes(f)) return null; // the replacement is already in the line? not informative
  if (line && f.length >= 8 && line.length > 0) return `Suggested fix: ${truncate(f, 400)}`;
  // a short replacement token: say what it replaces when we can find a candidate in the matched line
  const m = line && /(\w+\s*=\s*)(\w+)/.exec(line);
  if (m && f.length <= 24) return `Suggested fix: ${m[1]}${f} (instead of ${m[1]}${m[2]})`;
  return f.length <= 24 && !line ? null : `Suggested fix: ${truncate(f, 400)}`;
}

export function parseSemgrep(report: SemgrepReport, repoRoot: string): CodeFindingInput[] {
  const out: CodeFindingInput[] = [];
  for (const r of report.results ?? []) {
    const file = r.path.startsWith(`${repoRoot}/`) ? r.path.slice(repoRoot.length + 1) : r.path;
    const meta = r.extra?.metadata ?? {};
    const cwe = ([] as string[]).concat(meta.cwe ?? []);
    const title = truncate((r.extra?.message ?? r.check_id).split('\n')[0]!, 200);
    const evidence = r.extra?.lines ? r.extra.lines.trim().split('\n').slice(0, 3).join('\n').slice(0, 400) : null;
    out.push({
      kind: 'sast', ruleId: r.check_id, title, severity: semgrepSeverity(r), file, startLine: r.start?.line ?? null, endLine: r.end?.line ?? null,
      evidence, resolution: suggestedFix(r.extra?.fix, r.extra?.lines),
      references: [...(meta.references ?? []), ...cwe.map((c) => `https://cwe.mitre.org/data/definitions/${c.replace(/\D/g, '')}.html`)].slice(0, 8),
      fingerprint: hash(`sast|${r.check_id}|${file}|${(r.extra?.lines ?? '').trim()}`),
      category: cwe[0] ?? meta.category ?? null,
    });
  }
  return out;
}
