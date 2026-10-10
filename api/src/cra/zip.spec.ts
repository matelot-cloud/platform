import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip } from './zip';

describe('zip writer', () => {
  it('produces an archive that unzip can read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const file = join(dir, 'e.zip');
    writeFileSync(file, buildZip([{ name: 'manifest.json', data: '{"a":1}' }, { name: 'sboms/source.cdx.json', data: Buffer.from('{"bomFormat":"CycloneDX"}') }]));
    const out = execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' });
    expect(out).toBe('{"a":1}');
    expect(execFileSync('unzip', ['-l', file], { encoding: 'utf8' })).toContain('sboms/source.cdx.json');
  });
});
