import { cloudError } from '../integrations/cloud-error';
import { createHash } from 'node:crypto';
import type { IntegrationCredentials } from '../integrations/credentials';

/**
 * Minimal Docker Registry HTTP API v2 client: tags and manifest digests, with the
 * WWW-Authenticate bearer token flow used by GHCR, Docker Hub, GitLab, Harbor, ECR (with a token), …
 */
export interface ImageRef {
  registry: string;
  repository: string;
}

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

export function parseImageName(name: string): ImageRef {
  const parts = name.split('/');
  const hasHost = parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost');
  const registry = hasHost ? parts.shift()! : 'docker.io';
  let repository = parts.join('/');
  if (DOCKER_HUB_ALIASES.has(registry) && !repository.includes('/')) repository = `library/${repository}`;
  return { registry: DOCKER_HUB_ALIASES.has(registry) ? 'registry-1.docker.io' : registry, repository };
}

function basic(credentials: IntegrationCredentials): string | undefined {
  if (credentials.type === 'basic') return Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  if (credentials.type === 'token') return Buffer.from(`${credentials.username ?? 'oauth2'}:${credentials.token}`).toString('base64');
  return undefined;
}

export class RegistryClient {
  private readonly base: string;
  private bearer?: string;

  constructor(
    private readonly ref: ImageRef,
    private readonly credentials: IntegrationCredentials,
    insecure = false,
    private readonly presetBearer?: string,
  ) {
    this.base = `${insecure ? 'http' : 'https'}://${ref.registry}`;
    this.bearer = presetBearer;
  }

  /** Bearer tokens by challenge scope: ACR hands out metadata_read for the tags list and pull for manifests; one token does not cover both. */
  private readonly tokens = new Map<string, string>();

  private async request(path: string, method = 'GET', accept?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (accept) headers.Accept = accept;
    const send = (bearer?: string) => {
      const h = { ...headers };
      const auth = bearer ? `Bearer ${bearer}` : this.bearer ? `Bearer ${this.bearer}` : basic(this.credentials) ? `Basic ${basic(this.credentials)}` : undefined;
      if (auth) h.Authorization = auth;
      return fetch(`${this.base}${path}`, { method, headers: h, redirect: 'follow' });
    };
    // best guess for the scope this path needs (manifests/blobs → pull), so a cached token is reused without a round trip
    const guessed = /^\/v2\/(.+)\/(manifests|blobs)\//.exec(path) ? `repository:${this.ref.repository}:pull` : null;
    let response = await send(guessed ? this.tokens.get(guessed) : undefined);
    if (response.status === 401 && !this.presetBearer) {
      const challenge = response.headers.get('www-authenticate') ?? '';
      const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
      if (realm) {
        const service = /service="([^"]+)"/.exec(challenge)?.[1];
        const scope = /scope="([^"]+)"/.exec(challenge)?.[1] ?? guessed ?? `repository:${this.ref.repository}:pull`;
        const url = new URL(realm);
        if (service) url.searchParams.set('service', service);
        url.searchParams.set('scope', scope);
        const tokenHeaders: Record<string, string> = {};
        const b = basic(this.credentials);
        if (b) tokenHeaders.Authorization = `Basic ${b}`;
        const tokenResponse = await fetch(url, { headers: tokenHeaders });
        if (!tokenResponse.ok) throw new Error(`registry ${this.ref.registry} refused the credentials for scope ${scope} (${tokenResponse.status} ${cloudError(await tokenResponse.text().catch(() => ''))})`);
        const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
        const bearer = body.token ?? body.access_token;
        if (bearer) { this.tokens.set(scope, bearer); this.bearer = bearer; }
        response = await send(bearer);
      }
    }
    return response;
  }

  /** Verifies the registry accepts the credentials (`GET /v2/`). */
  async ping(): Promise<void> {
    const response = await this.request('/v2/');
    if (response.status === 401 || response.status === 403) throw new Error(`registry ${this.ref.registry} refused the credentials (${response.status})`);
    if (!response.ok && response.status !== 404) throw new Error(`registry ${this.ref.registry} responded ${response.status}`);
  }

  /** Verifies access: the tags list must be readable. */
  async probe(): Promise<number> {
    return (await this.tags()).length;
  }

  async tags(): Promise<string[]> {
    const all: string[] = [];
    let path: string | null = `/v2/${this.ref.repository}/tags/list?n=100`;
    for (let i = 0; path && i < 50; i++) {
      const response = await this.request(path);
      if (response.status === 404) throw new Error(`image ${this.ref.repository} not found on ${this.ref.registry}`);
      if (!response.ok) throw new Error(`registry ${this.ref.registry} responded ${response.status} for tags of ${this.ref.repository}`);
      const body = (await response.json()) as { tags?: string[] | null };
      all.push(...(body.tags ?? []));
      const link = response.headers.get('link');
      const next = link && /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
      path = next ? (next.startsWith('/') ? next : new URL(next, this.base).pathname + new URL(next, this.base).search) : null;
    }
    return all;
  }

  private static readonly MANIFEST_ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';

  /** All repositories of the registry (needs a `registry:catalog:*` token; built-in registry only). */
  async catalog(): Promise<string[]> {
    const out: string[] = [];
    let path: string | null = '/v2/_catalog?n=1000';
    while (path) {
      const response = await this.request(path, 'GET');
      if (!response.ok) throw new Error(`catalog → ${response.status}`);
      const body = (await response.json()) as { repositories?: string[] };
      out.push(...(body.repositories ?? []));
      const link = response.headers.get('link');
      const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
      path = m ? m[1] : null;
    }
    return out;
  }

  /** Raw manifest bytes + media type + digest (needed to copy an image without re-uploading it). */
  async manifest(reference: string): Promise<{ body: Buffer; mediaType: string; digest: string | null }> {
    const response = await this.request(`/v2/${this.ref.repository}/manifests/${encodeURIComponent(reference)}`, 'GET', RegistryClient.MANIFEST_ACCEPT);
    if (!response.ok) throw new Error(`manifest ${this.ref.repository}:${reference} → ${response.status}`);
    return { body: Buffer.from(await response.arrayBuffer()), mediaType: response.headers.get('content-type') ?? 'application/vnd.docker.distribution.manifest.v2+json', digest: response.headers.get('docker-content-digest') };
  }

  /** Cross-repository blob mount: instant copy of a layer inside the same registry. */
  async mountBlob(digest: string, fromRepository: string): Promise<boolean> {
    const response = await this.request(`/v2/${this.ref.repository}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(fromRepository)}`, 'POST');
    return response.status === 201;
  }

  async putManifest(reference: string, body: Buffer, mediaType: string): Promise<string | null> {
    const headers: Record<string, string> = { 'Content-Type': mediaType };
    const auth = this.bearer ? `Bearer ${this.bearer}` : undefined;
    if (auth) headers.Authorization = auth;
    const response = await fetch(`${this.base}/v2/${this.ref.repository}/manifests/${encodeURIComponent(reference)}`, { method: 'PUT', headers, body });
    if (!response.ok) throw new Error(`put manifest ${this.ref.repository}:${reference} → ${response.status} ${(await response.text()).slice(0, 120)}`);
    return response.headers.get('docker-content-digest');
  }

  /** Content digest of a tag (manifest or manifest list). */
  /** Build time of an image (config.created), following an index to its first platform manifest. Null when unavailable. */
  async builtAt(reference: string): Promise<Date | null> {
    try {
      const manifest = await this.manifest(reference);
      let doc = JSON.parse(manifest.body.toString('utf8')) as { config?: { digest: string }; manifests?: { digest: string }[] };
      if (doc.manifests?.length && !doc.config) {
        const sub = await this.manifest(doc.manifests[0].digest);
        doc = JSON.parse(sub.body.toString('utf8'));
      }
      if (!doc.config?.digest) return null;
      const response = await this.request(`/v2/${this.ref.repository}/blobs/${doc.config.digest}`, 'GET');
      if (!response.ok) return null;
      const config = (await response.json()) as { created?: string };
      return config.created ? new Date(config.created) : null;
    } catch {
      return null;
    }
  }

  async digest(tag: string): Promise<string | null> { return (await this.digestWithReason(tag)).digest; }

  /**
   * Digest of a tag. HEAD with every manifest media type, reading Docker-Content-Digest; when the header is missing
   * or HEAD is refused / fails (ACR does both), GET the manifest and compute sha256 over its exact bytes.
   * Never throws: the reason for a null digest is returned so the sync can log it instead of storing null silently.
   */
  async digestWithReason(tag: string): Promise<{ digest: string | null; reason?: string; via?: 'head' | 'get-header' | 'get-sha256' }> {
    const path = `/v2/${this.ref.repository}/manifests/${encodeURIComponent(tag)}`;
    const reasons: string[] = [];
    try {
      const head = await this.request(path, 'HEAD', RegistryClient.MANIFEST_ACCEPT);
      const header = head.ok ? head.headers.get('docker-content-digest') : null;
      if (header) return { digest: header.toLowerCase(), via: 'head' };
      reasons.push(head.ok ? 'HEAD: no Docker-Content-Digest header' : `HEAD → ${head.status}`);
    } catch (e) {
      reasons.push(`HEAD failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const get = await this.request(path, 'GET', RegistryClient.MANIFEST_ACCEPT);
      if (!get.ok) return { digest: null, reason: `${reasons.join('; ')}; GET → ${get.status} ${(await get.text().catch(() => '')).slice(0, 120)}` };
      const fromHeader = get.headers.get('docker-content-digest');
      if (fromHeader) return { digest: fromHeader.toLowerCase(), via: 'get-header' };
      const body = Buffer.from(await get.arrayBuffer());
      if (!body.length) return { digest: null, reason: `${reasons.join('; ')}; GET: empty manifest body` };
      return { digest: `sha256:${createHash('sha256').update(body).digest('hex')}`, via: 'get-sha256' };
    } catch (e) {
      return { digest: null, reason: `${reasons.join('; ')}; GET failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
