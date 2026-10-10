import { signV4 } from './aws-sigv4';

describe('SigV4', () => {
  it('produces a stable, well-formed authorization header', () => {
    const headers = signV4({ method: 'POST', url: 'https://api.ecr.eu-central-1.amazonaws.com/', service: 'ecr', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken' }, body: '{}', now: new Date('2026-01-02T03:04:05Z') });
    expect(headers['x-amz-date']).toBe('20260102T030405Z');
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260102\/eu-central-1\/ecr\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
    // deterministic for the same inputs
    const again = signV4({ method: 'POST', url: 'https://api.ecr.eu-central-1.amazonaws.com/', service: 'ecr', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken' }, body: '{}', now: new Date('2026-01-02T03:04:05Z') });
    expect(again.Authorization).toBe(headers.Authorization);
  });
});
