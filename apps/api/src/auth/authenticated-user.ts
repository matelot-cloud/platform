/** The identity attached to every authenticated request (req.user). */
export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  /** Keycloak subject */
  externalId: string;
  /** Cell-level role: 'admin' bypasses scoped RBAC everywhere. */
  platformRole: 'user' | 'admin';
  /** Set when the caller is a CI/API token rather than a person. */
  token?: { id: string; name: string; scopeType: string; scopeId: string; permissions: string[]; environments?: string[] };
}

/** Subset of the OIDC / Keycloak access-token claims we rely on. */
export interface KeycloakClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  azp?: string;
  aud?: string | string[];
}

/** The users.id to record for a principal: null for CI/API tokens (the audit actor names them). */
export const userIdOrNull = (user: AuthenticatedUser | null | undefined): string | null => (!user || user.token ? null : user.id);
