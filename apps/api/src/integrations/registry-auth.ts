import { cloudError } from './cloud-error';
import { signV4 } from './aws-sigv4';
import type { IntegrationCredentials } from './credentials';

export interface DockerCredentials {
  username: string;
  password: string;
  /** When the credentials stop working (ECR: 12 h, ACR: ~3 h). */
  expiresAt: Date;
}

const cache = new Map<string, DockerCredentials>();

/** Set by IdentityService at boot: mints the cell's OIDC token for one connection and one audience. */
type IdentityIssuer = (integrationId: string, audience: string) => Promise<string>;
let identityIssuer: IdentityIssuer | null = null;
export function setIdentityTokenIssuer(fn: IdentityIssuer | null): void { identityIssuer = fn; }
function identityToken(integrationId: string, audience: string): Promise<string> {
  if (!identityIssuer) throw new Error('workload identity unavailable: the cell identity key is not initialised');
  // A token for a placeholder subject would be rejected by any trust that pins integration:<connection id>.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integrationId)) {
    throw new Error('keyless connections are checked after they are created (the subject integration:<connection id> does not exist yet): connect, configure the trust, then Verify');
  }
  return identityIssuer(integrationId, audience);
}
const KEYED = new Set(['aws', 'azure', 'gcp', 'aws_wif', 'azure_wif', 'gcp_wif']);

/**
 * Turns a registry connection's stored credentials into Docker basic credentials.
 * Static ones (token/basic) pass through; AWS and Azure are exchanged for short-lived tokens and cached until shortly before expiry.
 */
export async function dockerCredentialsFor(host: string, creds: IntegrationCredentials, cacheKey?: string): Promise<DockerCredentials | null> {
  if (creds.type === 'basic') return { username: creds.username, password: creds.password, expiresAt: new Date(Date.now() + 365 * 86400_000) };
  if (creds.type === 'token') return { username: creds.username ?? 'oauth2', password: creds.token, expiresAt: new Date(Date.now() + 365 * 86400_000) };
  if (KEYED.has(creds.type)) {
    const id = creds.type === 'aws' ? creds.accessKeyId : creds.type === 'azure' ? creds.clientId : creds.type === 'gcp' ? creds.clientEmail : (creds as { integrationId: string }).integrationId;
    const key = cacheKey ?? `${host}:${creds.type}:${id}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt.getTime() - Date.now() > 10 * 60_000) return cached;
    let fresh: DockerCredentials;
    switch (creds.type) {
      case 'aws': fresh = await ecrToken(creds); break;
      case 'azure': fresh = await acrToken(host, creds); break;
      case 'gcp': fresh = await gcpToken(creds); break;
      case 'aws_wif': fresh = await ecrToken(await awsWifCredentials(creds)); break;
      case 'azure_wif': fresh = await acrExchange(host, creds.tenantId, await azureWifAccessToken(creds)); break;
      case 'gcp_wif': fresh = await gcpWifToken(creds); break;
      default: return null;
    }
    cache.set(key, fresh);
    return fresh;
  }
  return null;
}

/** AWS ECR: GetAuthorizationToken (SigV4) → base64("AWS:<password>") valid 12 hours. */
async function ecrToken(creds: { accessKeyId: string; secretAccessKey: string; region: string; sessionToken?: string }): Promise<DockerCredentials> {
  const url = `https://api.ecr.${creds.region}.amazonaws.com/`;
  const body = '{}';
  const headers = signV4({ method: 'POST', url, service: 'ecr', region: creds.region, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken' }, body });
  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) throw new Error(`ECR GetAuthorizationToken failed: ${response.status} ${cloudError(await response.text())}`);
  const data = (await response.json()) as { authorizationData?: { authorizationToken: string; expiresAt: number }[] };
  const auth = data.authorizationData?.[0];
  if (!auth) throw new Error('ECR returned no authorization data');
  const [username, ...rest] = Buffer.from(auth.authorizationToken, 'base64').toString('utf8').split(':');
  return { username, password: rest.join(':'), expiresAt: new Date(auth.expiresAt * 1000) };
}

/**
 * Azure Container Registry with a service principal: AAD client-credentials token → ACR refresh token
 * (docker username 00000000-0000-0000-0000-000000000000). Never hands the SP secret to anyone.
 */
async function acrToken(host: string, creds: { tenantId: string; clientId: string; clientSecret: string }): Promise<DockerCredentials> {
  return acrExchange(host, creds.tenantId, await azureAccessToken(creds.tenantId, { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret }));
}

async function azureAccessToken(tenantId: string, params: Record<string, string>): Promise<string> {
  const aad = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, scope: 'https://management.azure.com/.default' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!aad.ok) throw new Error(`Azure AD token failed: ${aad.status} ${cloudError(await aad.text())}`);
  return ((await aad.json()) as { access_token: string }).access_token;
}

/** Keyless Azure: the cell's OIDC token is the client assertion of a federated credential on the app registration. */
async function azureWifAccessToken(creds: { integrationId: string; tenantId: string; clientId: string }): Promise<string> {
  const assertion = await identityToken(creds.integrationId, 'api://AzureADTokenExchange');
  return azureAccessToken(creds.tenantId, { grant_type: 'client_credentials', client_id: creds.clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion });
}

/** ACR: an Azure AD access token → ACR refresh token, the docker password for the well-known username. */
async function acrExchange(host: string, tenantId: string, accessToken: string): Promise<DockerCredentials> {
  const exchange = await fetch(`https://${host}/oauth2/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'access_token', service: host, tenant: tenantId, access_token: accessToken }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!exchange.ok) throw new Error(`ACR token exchange failed: ${exchange.status} ${cloudError(await exchange.text())}`);
  const { refresh_token } = (await exchange.json()) as { refresh_token: string };
  return { username: '00000000-0000-0000-0000-000000000000', password: refresh_token, expiresAt: new Date(Date.now() + 3 * 3600_000) };
}

/** Keyless AWS: AssumeRoleWithWebIdentity (unsigned call) with the cell's OIDC token → temporary keys for ECR. */
async function awsWifCredentials(creds: { integrationId: string; roleArn: string; region: string }): Promise<{ accessKeyId: string; secretAccessKey: string; region: string; sessionToken?: string }> {
  const token = await identityToken(creds.integrationId, 'sts.amazonaws.com');
  const res = await fetch(`https://sts.${creds.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: creds.roleArn, RoleSessionName: `matelot-${creds.integrationId.slice(0, 8)}`, WebIdentityToken: token, DurationSeconds: '3600' }),
    signal: AbortSignal.timeout(15_000),
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`AWS AssumeRoleWithWebIdentity failed: ${res.status} ${cloudError(xml)}`);
  const pick = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? '';
  return { accessKeyId: pick('AccessKeyId'), secretAccessKey: pick('SecretAccessKey'), sessionToken: pick('SessionToken'), region: creds.region };
}

/** Keyless GCP: STS token exchange against the workload identity pool provider, then service-account impersonation. */
async function gcpWifToken(creds: { integrationId: string; provider: string; serviceAccount: string }): Promise<DockerCredentials> {
  const provider = creds.provider.replace(/^(https:)?\/\/iam\.googleapis\.com\//, '');
  const token = await identityToken(creds.integrationId, `https://iam.googleapis.com/${provider}`);
  const sts = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantType: 'urn:ietf:params:oauth:grant-type:token-exchange', audience: `//iam.googleapis.com/${provider}`, scope: 'https://www.googleapis.com/auth/cloud-platform', requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token', subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt', subjectToken: token }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!sts.ok) throw new Error(`GCP STS exchange failed: ${sts.status} ${cloudError(await sts.text())}`);
  const federated = ((await sts.json()) as { access_token: string }).access_token;
  const imp = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(creds.serviceAccount)}:generateAccessToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${federated}` },
    body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '3600s' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!imp.ok) throw new Error(`GCP service-account impersonation failed: ${imp.status} ${cloudError(await imp.text())} (grant roles/iam.workloadIdentityUser on ${creds.serviceAccount} to the pool principal)`);
  const data = (await imp.json()) as { accessToken: string; expireTime: string };
  return { username: 'oauth2accesstoken', password: data.accessToken, expiresAt: new Date(data.expireTime) };
}

/**
 * Google Artifact Registry / Container Registry with a service account: RS256-signed JWT → OAuth2 access token
 * (valid 1 hour), docker username "oauth2accesstoken". The key never leaves the platform.
 */
async function gcpToken(creds: { clientEmail: string; privateKey: string }): Promise<DockerCredentials> {
  const { createSign } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: creds.clientEmail, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(creds.privateKey.replace(/\\n/g, '\n')).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Google OAuth token failed: ${res.status} ${cloudError(await res.text())}`);
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  return { username: 'oauth2accesstoken', password: access_token, expiresAt: new Date(Date.now() + (expires_in ?? 3600) * 1000) };
}
