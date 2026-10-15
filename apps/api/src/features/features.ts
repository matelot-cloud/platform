/**
 * Named capabilities, so the licensing work (M13) can map each to Free / Premium / Ultimate without touching the code
 * that implements it. Nothing is gated today: every flag is on unless the cell turns it off with
 * MATELOT_FEATURES_DISABLED=a,b (an operator switch, also what the licence will drive later). `tier` is only the GitLab
 * reference point the mapping will start from — informative, not enforced.
 */
import { ForbiddenException } from '@nestjs/common';

export const FEATURES = {
  inherited_members: { label: 'Members at every level with inherited rows', gitlabTier: 'free' },
  member_expiry: { label: 'Membership expiration dates', gitlabTier: 'free' },
  bulk_invite: { label: 'Invite several people at once', gitlabTier: 'free' },
  invite_links: { label: 'Invite by e-mail with a one-time setup link', gitlabTier: 'free' },
  user_admin: { label: 'User administration (create, disable, reset password, delete)', gitlabTier: 'free' },
  service_accounts: { label: 'Service accounts (bot users owned by a scope)', gitlabTier: 'premium' },
  scope_access_tokens: { label: 'Scope access tokens (bot + token in one step)', gitlabTier: 'premium' },
  custom_roles: { label: 'Custom roles', gitlabTier: 'ultimate', built: false },
} as const;
export type Feature = keyof typeof FEATURES;

function disabledSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.MATELOT_FEATURES_DISABLED ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function featureEnabled(name: Feature, env: NodeJS.ProcessEnv = process.env): boolean {
  const f = FEATURES[name] as { built?: boolean };
  if (f.built === false) return false;
  return !disabledSet(env).has(name);
}

export function assertFeature(name: Feature, env: NodeJS.ProcessEnv = process.env): void {
  if (!featureEnabled(name, env)) throw new ForbiddenException(`The capability "${name}" (${FEATURES[name].label}) is not enabled on this cell`);
}

/** For GET /meta: every flag with its state (the web app hides what is off). */
export function featureStates(env: NodeJS.ProcessEnv = process.env): Record<Feature, boolean> {
  return Object.fromEntries((Object.keys(FEATURES) as Feature[]).map((k) => [k, featureEnabled(k, env)])) as Record<Feature, boolean>;
}
