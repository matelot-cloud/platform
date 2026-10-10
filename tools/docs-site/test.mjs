// Builds the docs site into a temp dir and checks the output: every page, rewritten links, search index, no raw entities.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'docs-site-'));
execFileSync('node', [join(here, 'build.mjs'), '--out', out], { stdio: 'pipe' });
const pages = readdirSync(out).filter((f) => f.endsWith('.html'));
assert.ok(pages.length >= 20, `only ${pages.length} pages`);
for (const f of ['index.html', 'cli.html', 'backup-restore.html', 'site.css', 'site.js', 'search-index.json', 'examples/github-actions.yml', 'logo.png']) assert.ok(existsSync(join(out, f)), `missing ${f}`);
// links to other docs are rewritten to pages; repository files point at GitHub; headings get anchors; the nav marks the page
const prov = readFileSync(join(out, 'cell-provisioning.html'), 'utf8');
assert.match(prov, /href="backup-restore\.html"/);
assert.match(prov, /<h2 id="[a-z0-9-]+"><a class="anchor"/);
assert.match(prov, /<li class="current"><a href="cell-provisioning\.html">Provisioning a cell<\/a>/);
assert.doesNotMatch(prov, /href="[^"]*\.md"/, 'a .md link survived');
const index = JSON.parse(readFileSync(join(out, 'search-index.json'), 'utf8'));
assert.equal(index.length, pages.length);
const br = index.find((p) => p.slug === 'backup-restore');
assert.ok(br.headings.includes('What is in an archive'));
assert.doesNotMatch(br.text, /&#39;|&amp;|&lt;/, 'entities in search text');
// the CLI tables survive: a row with a pipe inside code renders as one row with two cells
const cli = readFileSync(join(out, 'cli.html'), 'utf8');
assert.match(cli, /<code>matelot gate --env ID --image REF \| --version V \| --ref SHA<\/code><\/td>/);
console.log(`docs site ok (${pages.length} pages)`);
