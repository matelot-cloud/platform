import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { NOTIFICATION_EVENTS, PolicyRules } from '../database/schema';
import { DEFAULT_SLA, type SlaDays } from '../database/schema';
import { PoliciesService } from '../policies/policies.service';
import { POLICY_TEMPLATES } from '../policies/templates';
import { RemediationService } from '../remediation/remediation.service';
import { ScopeChain } from '../rbac/scope.types';
import { NotificationsService } from './notifications.service';

/** Declarative configuration applied at a scope (organization / workspace / team / project). Idempotent: keyed by name. */
export interface ConfigDocument {
  channels?: { name: string; kind: 'slack' | 'teams' | 'email' | 'webhook'; url?: string; events?: string[]; enabled?: boolean }[];
  policies?: { name: string; template?: string; description?: string; environments?: string[]; rules?: Partial<PolicyRules>; action?: 'block' | 'warn'; enforceOnDeploy?: boolean; enabled?: boolean }[];
  sla?: { critical?: number; high?: number; medium?: number; low?: number; jiraProjectKey?: string | null };
}
export interface ApplyResult { dryRun: boolean; changes: { kind: 'channel' | 'policy' | 'sla'; name: string; action: 'create' | 'update' | 'unchanged' | 'skip'; detail?: string }[] }

@Injectable()
export class ConfigApplyService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly policies: PoliciesService,
    private readonly remediation: RemediationService,
  ) {}

  async apply(user: AuthenticatedUser, chain: ScopeChain, doc: ConfigDocument, dryRun = false): Promise<ApplyResult> {
    const changes: ApplyResult['changes'] = [];
    // ---- channels: keyed by name within this exact scope
    if (doc.channels) {
      const existing = (await this.notifications.list(chain.organizationId, chain)).filter((c) => !c.inherited);
      for (const ch of doc.channels) {
        if (!ch.name || !ch.kind) throw new BadRequestException('each channel needs name and kind');
        const events = (ch.events ?? [...NOTIFICATION_EVENTS]).filter((e) => (NOTIFICATION_EVENTS as readonly string[]).includes(e));
        const bad = (ch.events ?? []).filter((e) => !(NOTIFICATION_EVENTS as readonly string[]).includes(e));
        if (bad.length) throw new BadRequestException(`channel ${ch.name}: unknown events ${bad.join(', ')} (valid: ${NOTIFICATION_EVENTS.join(', ')})`);
        const cur = existing.find((c) => c.name === ch.name);
        if (!cur) {
          if (!ch.url) throw new BadRequestException(`channel ${ch.name}: url is required to create it`);
          changes.push({ kind: 'channel', name: ch.name, action: 'create', detail: `${ch.kind} · ${events.length} events` });
          if (!dryRun) await this.notifications.create(user, chain, { name: ch.name, kind: ch.kind, url: ch.url, events });
        } else {
          const sameUrl = !ch.url || (await this.notifications.hasSameTarget(cur.id, cur.kind, ch.url));
          const same = cur.kind === ch.kind && JSON.stringify([...cur.events].sort()) === JSON.stringify([...events].sort()) && (ch.enabled === undefined || cur.enabled === ch.enabled) && sameUrl;
          if (cur.kind !== ch.kind) { changes.push({ kind: 'channel', name: ch.name, action: 'skip', detail: `exists as ${cur.kind}; kind cannot change — delete and recreate` }); continue; }
          changes.push({ kind: 'channel', name: ch.name, action: same ? 'unchanged' : 'update', detail: same ? undefined : [!sameUrl ? 'url' : null, JSON.stringify([...cur.events].sort()) !== JSON.stringify([...events].sort()) ? 'events' : null, ch.enabled !== undefined && cur.enabled !== ch.enabled ? 'enabled' : null].filter(Boolean).join(', ') });
          if (!same && !dryRun) await this.notifications.update(user, cur.id, { url: sameUrl ? undefined : ch.url, events, enabled: ch.enabled });
        }
      }
    }
    // ---- policies: keyed by name at this exact scope
    if (doc.policies) {
      const here = (await this.policies.inForce(chain)).filter((p) => !p.inherited);
      for (const pol of doc.policies) {
        if (!pol.name) throw new BadRequestException('each policy needs a name');
        const tpl = pol.template ? POLICY_TEMPLATES.find((t) => t.id === pol.template) : null;
        if (pol.template && !tpl) throw new BadRequestException(`policy ${pol.name}: unknown template ${pol.template} (valid: ${POLICY_TEMPLATES.map((t) => t.id).join(', ')})`);
        const rules: PolicyRules = { maxSeverity: 'high', blockKev: true, blockSecrets: true, maxIacSeverity: null, requireSbom: true, honourDecisions: true, ...(tpl?.rules ?? {}), ...(pol.rules ?? {}) };
        const desired = { name: pol.name, description: pol.description ?? tpl?.description, environmentKinds: pol.environments ?? tpl?.environmentKinds ?? [], rules, action: pol.action ?? tpl?.action ?? 'block', enforceOnDeploy: pol.enforceOnDeploy ?? tpl?.enforceOnDeploy ?? false, enabled: pol.enabled ?? true };
        const cur = here.find((p) => p.name === pol.name);
        if (!cur) {
          changes.push({ kind: 'policy', name: pol.name, action: 'create', detail: `${desired.action}${desired.environmentKinds.length ? ` · ${desired.environmentKinds.join('/')}` : ''}` });
          if (!dryRun) { const created = await this.policies.create(user, chain, desired); if (!desired.enabled) await this.policies.update(user, created.id, { enabled: false }); }
        } else {
          const norm = (r: PolicyRules) => JSON.stringify(Object.fromEntries(Object.entries(r).sort()));
          const same = norm(cur.rules) === norm(rules) && JSON.stringify([...cur.environmentKinds].sort()) === JSON.stringify([...desired.environmentKinds].sort()) && cur.action === desired.action && cur.enforceOnDeploy === desired.enforceOnDeploy && cur.enabled === desired.enabled;
          changes.push({ kind: 'policy', name: pol.name, action: same ? 'unchanged' : 'update' });
          if (!same && !dryRun) await this.policies.update(user, cur.id, { description: desired.description ?? null, environmentKinds: desired.environmentKinds, rules, action: desired.action, enforceOnDeploy: desired.enforceOnDeploy, enabled: desired.enabled });
        }
      }
    }
    // ---- SLA (organization-level setting)
    if (doc.sla) {
      const cur = await this.remediation.settings(chain.organizationId);
      const { jiraProjectKey, ...days } = doc.sla;
      const same = Object.entries(days).every(([k, v]) => v === undefined || (cur.slaDays ?? DEFAULT_SLA)[k as keyof SlaDays] === v) && (jiraProjectKey === undefined || (cur.jiraProjectKey ?? null) === (jiraProjectKey ?? null));
      changes.push({ kind: 'sla', name: 'remediation settings', action: same ? 'unchanged' : 'update', detail: same ? undefined : Object.entries(days).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}d`).concat(jiraProjectKey !== undefined ? [`jira=${jiraProjectKey ?? '-'}`] : []).join(' ') });
      if (!same && !dryRun) await this.remediation.updateSettings(user, chain.organizationId, { slaDays: Object.fromEntries(Object.entries(days).filter(([, v]) => v !== undefined)) as never, jiraProjectKey });
    }
    return { dryRun, changes };
  }
}
