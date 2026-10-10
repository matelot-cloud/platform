import { generateKeyPairSync } from 'node:crypto';

/** Encodes an OpenSSH "string" field: 4-byte big-endian length + bytes. */
function sshString(buffer: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

/** OpenSSH mpint: big-endian two's complement; a leading zero byte if the high bit is set. */
function sshMpint(value: Buffer): Buffer {
  const trimmed = value[0] === 0 ? value.subarray(1) : value;
  return sshString(trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

export interface GeneratedSshKey {
  /** PKCS#1 PEM, accepted by every OpenSSH version and git host. Stored encrypted, never shown. */
  privateKeyPem: string;
  /** `ssh-rsa AAAA… comment` — what the team pastes into GitHub / GitLab / Bitbucket as a deploy key. */
  publicKeyOpenSsh: string;
  fingerprint: string;
}

/** Generates an RSA 4096 deploy key without any external tool. */
export function generateDeployKey(comment = 'secops-platform'): GeneratedSshKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');
  const wire = Buffer.concat([sshString(Buffer.from('ssh-rsa')), sshMpint(e), sshMpint(n)]);
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const fingerprint = `SHA256:${createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    publicKeyOpenSsh: `ssh-rsa ${wire.toString('base64')} ${comment}`,
    fingerprint,
  };
}
