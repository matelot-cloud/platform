/** Credential shapes stored encrypted on an integration. */
export type IntegrationCredentials =
  | { type: 'app'; privateKey: string; webhookSecret?: string }
  | { type: 'token'; token: string; username?: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'ssh'; privateKey: string }
  /** AWS ECR: exchanged for a 12-hour Docker token by the platform. */
  | { type: 'aws'; accessKeyId: string; secretAccessKey: string; region: string; sessionToken?: string }
  /** Azure Container Registry service principal: exchanged for a short-lived ACR token by the platform. */
  | { type: 'azure'; tenantId: string; clientId: string; clientSecret: string }
  | { type: 'gcp'; clientEmail: string; privateKey: string; projectId?: string }
  /**
   * Keyless (workload identity federation): the cell signs a short-lived OIDC token (sub = integration:<id>) and the
   * cloud exchanges it; nothing secret is stored. `integrationId` is bound when the credentials are read back.
   */
  | { type: 'gcp_wif'; integrationId: string; provider: string; serviceAccount: string }
  | { type: 'aws_wif'; integrationId: string; roleArn: string; region: string }
  | { type: 'azure_wif'; integrationId: string; tenantId: string; clientId: string }
  | { type: 'none' };

export const PROVIDER_INFO = {
  github: { label: 'GitHub App (organization-wide, with webhooks)', authTypes: ['app'], inventory: true },
  github_token: { label: 'GitHub (token)', authTypes: ['token'], inventory: true },
  gitlab: { label: 'GitLab (token)', authTypes: ['token'], inventory: true },
  git: { label: 'Git repository (HTTPS or SSH)', authTypes: ['none', 'token', 'basic', 'ssh'], inventory: false },
  registry: { label: 'Container registry', authTypes: ['none', 'token', 'basic', 'aws', 'azure', 'gcp', 'gcp_wif', 'aws_wif', 'azure_wif'], inventory: false },
  /** Issue tracker: site URL + Atlassian e-mail and API token (basic). Used by remediation → create issue. */
  jira: { label: 'Jira (issues)', authTypes: ['basic'], inventory: false },
  matelot: { label: 'Matelot container registry (built in)', authTypes: ['none'], inventory: false },
} as const;
