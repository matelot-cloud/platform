import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readZip } from './zip-read';

/** Tiny ZIP writer for the test (stored or deflated entries). CRCs are not checked by the reader. */
function makeZip(files: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(f.deflate ? 8 : 0, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(f.deflate ? 8 : 0, 10); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body); central.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('reads a >5 MB evidence bundle in-process (stored + deflated), no unzip binary', () => {
  const sbom = randomBytes(6 * 1024 * 1024); // incompressible 6 MB
  const findings = Buffer.from(JSON.stringify({ items: Array.from({ length: 50_000 }, (_, i) => ({ i, advisory: `CVE-2026-${i}` })) }));
  const zip = makeZip([{ name: 'sboms/image.cdx.json', data: sbom }, { name: 'findings.json', data: findings, deflate: true }, { name: 'checksums.txt', data: Buffer.from('x') }]);
  assert.ok(zip.length > 5 * 1024 * 1024);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['sboms/image.cdx.json', 'findings.json', 'checksums.txt']);
  assert.equal(sha(entries[0]!.data()), sha(sbom));
  assert.equal(sha(entries[1]!.data()), sha(findings));
});

test('a tampered file yields a different hash (the server then reports FAIL, CLI exits 2)', () => {
  const original = Buffer.from('{"gate":"pass"}');
  const tampered = makeZip([{ name: 'gate.json', data: Buffer.from('{"gate":"fail"}') }]);
  assert.notEqual(sha(readZip(tampered)[0]!.data()), sha(original));
});

test('rejects something that is not a zip', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
});
