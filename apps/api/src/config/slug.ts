/** URL-safe identifier used for organizations, workspaces, teams and projects. */
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const SLUG_MESSAGE =
  'must be 1-63 chars of lowercase letters, digits and hyphens, and cannot start or end with a hyphen';
