import { createHash, createHmac } from 'node:crypto';

/** Minimal AWS Signature Version 4 for JSON POST requests (no SDK dependency). */
export function signV4(input: { method: string; url: string; service: string; region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; headers: Record<string, string>; body: string; now?: Date }): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: url.host, 'x-amz-date': amzDate };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;
  const canonicalHeaders = Object.keys(headers).map((k) => k.toLowerCase()).sort().map((k) => `${k}:${headers[Object.keys(headers).find((h) => h.toLowerCase() === k)!].trim()}\n`).join('');
  const signedHeaders = Object.keys(headers).map((k) => k.toLowerCase()).sort().join(';');
  const payloadHash = createHash('sha256').update(input.body).digest('hex');
  const canonicalRequest = [input.method.toUpperCase(), url.pathname || '/', url.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = createHmac('sha256', `AWS4${input.secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(input.region).digest();
  const kService = createHmac('sha256', kRegion).update(input.service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
