import { parseImageName } from './registry.client';

describe('parseImageName', () => {
  it('handles Docker Hub shorthand, official images and other registries', () => {
    expect(parseImageName('nginx')).toEqual({ registry: 'registry-1.docker.io', repository: 'library/nginx' });
    expect(parseImageName('acme/payment-api')).toEqual({ registry: 'registry-1.docker.io', repository: 'acme/payment-api' });
    expect(parseImageName('ghcr.io/acme/payment-api')).toEqual({ registry: 'ghcr.io', repository: 'acme/payment-api' });
    expect(parseImageName('registry.gitlab.com/group/sub/app')).toEqual({ registry: 'registry.gitlab.com', repository: 'group/sub/app' });
    expect(parseImageName('localhost:5000/app')).toEqual({ registry: 'localhost:5000', repository: 'app' });
  });
});

describe('RegistryClient.digest fallback (audit #9: ACR tag with digest null)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  it('HEAD without Docker-Content-Digest → GET, and computes sha256 of the manifest bytes when no header', async () => {
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}');
    const calls: string[] = [];
    global.fetch = (async (_url: string, init?: { method?: string }) => {
      calls.push(init?.method ?? 'GET');
      return new Response(init?.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': 'application/vnd.oci.image.index.v1+json' } });
    }) as typeof fetch;
    const { RegistryClient } = await import('./registry.client');
    const client = new (RegistryClient as unknown as new (ref: { host: string; repository: string }, auth?: unknown) => { digest(t: string): Promise<string | null> })({ host: 'acme.azurecr.io', repository: 'demo-service' }, { type: 'none' });
    expect(await client.digest('preprod')).toBe(`sha256:${createHash('sha256').update(body).digest('hex')}`);
    expect(calls).toContain('HEAD');
    expect(calls).toContain('GET');
  });
});

describe('RegistryClient.digestWithReason: ACR behaviours never leave a tag without a digest silently', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const body = Buffer.from('{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}');
  const mk = async (behaviour: (method: string, accept: string | undefined) => Response | Promise<Response>) => {
    const accepts: string[] = [];
    global.fetch = (async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => { accepts.push(init?.headers?.Accept ?? ''); return behaviour(init?.method ?? 'GET', init?.headers?.Accept); }) as typeof fetch;
    const { RegistryClient } = await import('./registry.client');
    const client = new (RegistryClient as unknown as new (ref: { host: string; repository: string }, auth: unknown) => { digestWithReason(t: string): Promise<{ digest: string | null; reason?: string; via?: string }> })({ host: 'matelottest.azurecr.io', repository: 'demo-service' }, { type: 'none' });
    return { client, accepts };
  };
  const sha = `sha256:${require('node:crypto').createHash('sha256').update(body).digest('hex')}`;

  it('HEAD throws (auth challenge on a bodiless response) → GET, sha256 of the manifest bytes', async () => {
    const { client, accepts } = await mk((m) => { if (m === 'HEAD') throw new Error('socket hang up'); return new Response(body, { status: 200 }); });
    expect(await client.digestWithReason('1.0.25')).toEqual({ digest: sha, via: 'get-sha256' });
    expect(accepts.every((a) => a.includes('application/vnd.oci.image.index.v1+json') && a.includes('application/vnd.docker.distribution.manifest.list.v2+json'))).toBe(true);
  });
  it('HEAD 404 (ACR without the right Accept) → GET header wins when present', async () => {
    const { client } = await mk((m) => (m === 'HEAD' ? new Response(null, { status: 404 }) : new Response(body, { status: 200, headers: { 'docker-content-digest': 'SHA256:ABC' } })));
    expect(await client.digestWithReason('preprod')).toEqual({ digest: 'sha256:abc', via: 'get-header' });
  });
  it('both fail → null WITH a reason (logged by the sync, never a silent null)', async () => {
    const { client } = await mk((m) => new Response(m === 'HEAD' ? null : 'denied', { status: 401 }));
    const r = await client.digestWithReason('1.0.24');
    expect(r.digest).toBeNull();
    expect(r.reason).toMatch(/HEAD → 401; GET → 401/);
  });
});

describe('ACR-style scoped tokens: tags/list needs metadata_read, manifests need pull', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const REPO = 'demo-service';
  const body = Buffer.from('{"schemaVersion":2}');
  const sha = `sha256:${require('node:crypto').createHash('sha256').update(body).digest('hex')}`;

  function acr() {
    const tokenRequests: string[] = [];
    const calls: string[] = [];
    global.fetch = (async (input: string | URL, init?: { method?: string; headers?: Record<string, string> }) => {
      const url = String(input); const auth = init?.headers?.Authorization ?? ''; const m = init?.method ?? 'GET';
      calls.push(`${m} ${url.replace(/^https?:\/\/[^/]+/, '')} ${auth.split(' ')[0] || '-'}`);
      if (url.includes('/oauth2/token')) { const scope = new URL(url).searchParams.get('scope') ?? ''; tokenRequests.push(scope); return new Response(JSON.stringify({ access_token: `tok:${scope}` }), { status: 200 }); }
      const challenge = (scope: string) => new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="https://matelottest.azurecr.io/oauth2/token",service="matelottest.azurecr.io",scope="${scope}"` } });
      if (url.includes(`/v2/${REPO}/tags/list`)) {
        if (auth !== `Bearer tok:repository:${REPO}:metadata_read`) return challenge(`repository:${REPO}:metadata_read`);
        return new Response(JSON.stringify({ tags: ['1.0.25', 'preprod'] }), { status: 200 });
      }
      if (url.includes(`/v2/${REPO}/manifests/`)) {
        if (auth !== `Bearer tok:repository:${REPO}:pull`) return challenge(`repository:${REPO}:pull`); // the metadata_read token is NOT enough
        return new Response(m === 'HEAD' ? null : body, { status: 200, headers: { 'docker-content-digest': sha } });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    return { tokenRequests, calls };
  }

  it('tags then digest: the client re-challenges for the pull scope instead of reusing the metadata_read token', async () => {
    const r = acr();
    const { RegistryClient } = await import('./registry.client');
    const client = new (RegistryClient as unknown as new (ref: { host: string; repository: string; registry: string }, auth: unknown) => { tags(): Promise<string[]>; digestWithReason(t: string): Promise<{ digest: string | null; via?: string; reason?: string }> })({ host: 'matelottest.azurecr.io', registry: 'matelottest.azurecr.io', repository: REPO }, { type: 'basic', username: '00000000-0000-0000-0000-000000000000', password: 'refresh' });
    expect(await client.tags()).toEqual(['1.0.25', 'preprod']);
    expect(await client.digestWithReason('1.0.25')).toEqual({ digest: sha, via: 'head' });
    expect(await client.digestWithReason('preprod')).toEqual({ digest: sha, via: 'head' });       // cached pull token, no new challenge
    expect(r.tokenRequests).toEqual([`repository:${REPO}:metadata_read`, `repository:${REPO}:pull`]);
  });

  it('when the pull token is refused, the reason names the scope and status (surfaced in the image lastError)', async () => {
    const r = acr();
    const inner = global.fetch;
    global.fetch = (async (input: string | URL, init?: RequestInit) => { const url = String(input); if (url.includes('/oauth2/token') && url.includes('pull')) return new Response('AcrPull missing', { status: 403 }); return inner(input, init); }) as typeof fetch;
    const { RegistryClient } = await import('./registry.client');
    const client = new (RegistryClient as unknown as new (ref: unknown, auth: unknown) => { digestWithReason(t: string): Promise<{ digest: string | null; reason?: string }> })({ host: 'matelottest.azurecr.io', registry: 'matelottest.azurecr.io', repository: REPO }, { type: 'basic', username: 'u', password: 'p' });
    const d = await client.digestWithReason('1.0.25');
    expect(d.digest).toBeNull();
    expect(d.reason).toMatch(/refused the credentials for scope repository:demo-service:pull \(403/);
    void r;
  });
});
