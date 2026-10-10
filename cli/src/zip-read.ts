/**
 * Minimal in-process ZIP reader (stored + deflate), enough for evidence bundles: no `unzip` binary, no buffer limits.
 * Reads the central directory, so entry sizes come from the archive itself.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry { name: string; data: () => Buffer }

export function readZip(buf: Buffer): ZipEntry[] {
  // End of central directory: signature 0x06054b50, searched backwards (comment may follow).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    out.push({
      name,
      data: () => {
        if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
        const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
        const raw = buf.subarray(start, start + compSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`unsupported compression method ${method} for ${name}`);
      },
    });
  }
  return out;
}
