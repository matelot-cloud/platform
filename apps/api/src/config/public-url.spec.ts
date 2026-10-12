import { resolvePublicApiBase, publicApiBase } from './public-url';
import { OauthService } from '../oauth/oauth.service';

describe('public API base: what the OAuth metadata and friends advertise', () => {
  it('API_PUBLIC_URL wins, then WEB_BASE_URL (the cell URL behind the proxy), then the dev listen address', () => {
    expect(resolvePublicApiBase({ API_PUBLIC_URL: 'https://api.example/', WEB_BASE_URL: 'https://app.example', PORT: 3000 })).toBe('https://api.example');
    expect(resolvePublicApiBase({ WEB_BASE_URL: 'http://localhost/', PORT: 3000 })).toBe('http://localhost');
    expect(resolvePublicApiBase({ PORT: 3000 })).toBe('http://localhost:3000');
  });
  it('ConfigService form follows the same precedence', () => {
    const cfg = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] }) as never;
    expect(publicApiBase(cfg({ API_PUBLIC_URL: undefined, WEB_BASE_URL: 'https://acme.platform.example.com', PORT: 3000 }))).toBe('https://acme.platform.example.com');
    expect(publicApiBase(cfg({ API_PUBLIC_URL: undefined, WEB_BASE_URL: undefined, PORT: 4000 }))).toBe('http://localhost:4000');
  });
  it('the well-known document uses the public base for the issuer and every endpoint (never the listen address)', () => {
    const svc = Object.create(OauthService.prototype) as OauthService;
    Object.assign(svc, { issuer: resolvePublicApiBase({ WEB_BASE_URL: 'http://localhost' }), webBaseUrl: 'http://localhost' });
    const m = svc.metadata() as unknown as Record<string, string>;
    expect(m.issuer).toBe('http://localhost');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) expect(m[k]).toMatch(/^http:\/\/localhost\/api\/v1\/oauth\//);
    expect(JSON.stringify(m)).not.toContain('localhost:3000');
  });
});
