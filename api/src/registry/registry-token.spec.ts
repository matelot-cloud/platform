import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { issueRegistryToken, libtrustKeyId, loadRegistryKey, parseScopes } from './registry-token';

describe('registry token', () => {
  it('computes a libtrust key id in the documented shape', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = libtrustKeyId(createPublicKey(privateKey));
    expect(kid).toMatch(/^([A-Z2-7]{4}:){11}[A-Z2-7]{4}$/);
  });

  it('issues RS256 JWTs the registry can verify, with the requested access', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = loadRegistryKey(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    const { token } = issueRegistryToken(key, { issuer: 'cell', service: 'reg', subject: 'sk_1', access: [{ type: 'repository', name: 'pay/api', actions: ['pull', 'push'] }] });
    const [h, p, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toMatchObject({ alg: 'RS256', kid: key.kid });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'cell', aud: 'reg', sub: 'sk_1', access: [{ type: 'repository', name: 'pay/api', actions: ['pull', 'push'] }] });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key.publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('parses scopes', () => {
    expect(parseScopes('repository:acme/app:push,pull')).toEqual([{ type: 'repository', name: 'acme/app', actions: ['push', 'pull'] }]);
    expect(parseScopes(['repository:a/b:pull', 'registry:catalog:*'])).toHaveLength(2);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe('registry token: personal access tokens', () => {
  it('a personal token is accepted as password with any username; access follows the user RBAC per repository', async () => {
    const { RegistryService } = await import('./registry.service');
    const { issueRegistryToken, verifyRegistryToken } = await import('./registry-token');
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const svc = Object.create(RegistryService.prototype) as { token(auth: string, scopes: { type: string; name: string; actions: string[] }[]): Promise<{ token: string }> };
    Object.assign(svc, {
      key: { privateKey, publicKey, kid: 'k' }, issuer: 'cell', service: 'reg',
      personalTokens: { authenticate: async (secret: string) => (secret === 'spt_ok' ? { user: { id: 'u1', email: 'dev@acme', platformRole: 'user' }, tokenId: 't', scope: 'write' } : null) },
      access: { forUser: async () => ({}) },
      authorization: { hasPermission: (_c: unknown, perm: string) => perm === 'registry:pull' || perm === 'registry:push' },
      resolver: { resolveChain: async () => ({}) },
      resolvePath: async (p: string) => (p.includes('/demo') ? { serviceId: 's', organizationId: 'o', buildName: 'demo', environment: p.endsWith('/prod') ? { id: 'e', slug: 'prod', protected: true } : undefined } : null),
    });
    void issueRegistryToken;
    const basic = 'Basic ' + Buffer.from('token:spt_ok').toString('base64');
    const t = await svc.token(basic, [{ type: 'repository', name: 'w/t/p/demo', actions: ['pull', 'push'] }, { type: 'repository', name: 'w/t/p/demo/prod', actions: ['pull', 'push'] }]);
    const claims = verifyRegistryToken(publicKey, t.token)!;
    expect(claims.sub).toBe('user:dev@acme');
    expect(claims.access).toEqual([{ type: 'repository', name: 'w/t/p/demo', actions: ['pull', 'push'] }, { type: 'repository', name: 'w/t/p/demo/prod', actions: ['pull'] }]); // protected env: no push without sudo
    await expect(svc.token('Basic ' + Buffer.from('token:spt_bad').toString('base64'), [])).rejects.toThrow(/personal access token/);
  });
});
