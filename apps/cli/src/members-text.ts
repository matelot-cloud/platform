/** Human-readable results of the members / users / service-account commands (--json prints the raw response). */
interface Added { added?: { email: string; role: string; updated: boolean }[]; skipped?: { email: string; reason: string }[]; invited?: { email: string; setupLink: string | null; emailed: boolean; viaIdentityProvider: boolean }[] }
interface Link { setupLink?: string | null; emailed?: boolean; temporaryPassword?: boolean; user?: { email: string } }
interface Token { name?: string; scope?: string; expiresAt?: string; token?: string }

function linkLines(who: string, r: Link): string[] {
  if (r.temporaryPassword) return [`${who}: temporary password set (changed at the next sign-in)`];
  if (r.emailed) return [`${who}: one-time setup link e-mailed (valid 7 days)`];
  if (r.setupLink) return [`${who}: no e-mail on this cell — send this one-time link yourself (shown once):`, `  ${r.setupLink}`];
  return [];
}

function tokenLines(t: Token): string[] {
  return [`token ${t.name} (${t.scope}, until ${String(t.expiresAt ?? '').slice(0, 10)}) — shown once, store it now:`, `  ${t.token}`];
}

export function membersSummary(resource: string, verb: string, res: unknown): string | null {
  if (!res || typeof res !== 'object') return null;
  if (resource === 'members' && verb === 'add') {
    const r = res as Added;
    const lines = (r.added ?? []).map((a) => `${a.updated ? 'updated' : 'added'} ${a.email} as ${a.role}`);
    for (const i of r.invited ?? []) lines.push(...(i.viaIdentityProvider ? [`${i.email}: invited — access at the first sign-in through your identity provider`] : linkLines(i.email, i)));
    for (const s of r.skipped ?? []) lines.push(`not added ${s.email}: ${s.reason}`);
    return lines.join('\n');
  }
  if (resource === 'users' && (verb === 'create' || verb === 'reset-password')) {
    const r = res as Link;
    return [verb === 'create' ? `created ${r.user?.email}` : 'password reset', ...linkLines(r.user?.email ?? 'the user', r)].join('\n');
  }
  if (resource === 'users' && verb === 'delete') { const r = res as { email?: string; memberships?: number; tokens?: number }; return `deleted ${r.email} (${r.memberships ?? 0} roles, ${r.tokens ?? 0} tokens removed)`; }
  if (resource === 'service-accounts' && (verb === 'token-create' || verb === 'token-rotate')) return tokenLines(res as Token).join('\n');
  if (resource === 'service-accounts' && verb === 'create') { const r = res as { id: string; name: string; username: string }; return `service account ${r.name} (${r.id})\n  username ${r.username}\n  next: matelot service-accounts token-create --id ${r.id} --name ci --token-scope read`; }
  if (resource === 'access-token' && verb === 'create') { const r = res as { serviceAccount: { id: string; name: string }; token: Token }; return [`bot member ${r.serviceAccount.name} (${r.serviceAccount.id})`, ...tokenLines(r.token)].join('\n'); }
  if (resource === 'invite' && verb === 'accept') { const r = res as { email: string; signInUrl: string }; return `password set for ${r.email} — sign in at ${r.signInUrl}`; }
  return null;
}
