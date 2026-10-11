// Renders docs/ into a temp dir and checks the output (what CI runs). Run: node tools/docs-site/test.mjs
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildDocs, SITE, PRODUCT } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const out = mkdtempSync(join(tmpdir(), 'docs-'));
const r = buildDocs({ docsDir: join(root, 'docs'), out, version: 'v9.9' });
assert.deepEqual(r.problems, []);

// every page of the SITE table exists in docs/ (an old tag may miss some; main may not)
for (const s of SITE) for (const p of s.pages) if (!p.generated) assert.ok(existsSync(join(root, 'docs', p.src)), `SITE lists ${p.src} but docs/ has no such file`);
const pages = readdirSync(out).filter((f) => f.endsWith('.html'));
assert.equal(pages.length, r.pages);
assert.ok(pages.length >= 20, `only ${pages.length} docs pages`);
for (const f of ['index.html', 'install.html', 'site.css', 'site.js', 'search-index.json', 'examples/github-actions.yml']) assert.ok(existsSync(join(out, f)), `missing ${f}`);

// rewritten links, anchors, current page, version meta, shared header (Home / Docs / Install / GitHub)
const prov = readFileSync(join(out, 'backup-restore.html'), 'utf8');
assert.match(prov, /href="install\.html"/);
assert.match(prov, /<h2 id="[a-z0-9-]+"><a class="anchor"/);
assert.match(prov, /<li class="current"><a href="backup-restore\.html">Backup and restore<\/a>/);
assert.match(prov, /<meta name="docs-version" content="v9\.9">/);
assert.match(prov, /class="top-links"><a href="\.\.\/\.\.\/">Home<\/a><a class="current" href="index\.html">Docs<\/a><a href="install\.html">Install<\/a><a href="https:\/\/github\.com\/matelot-io\/matelot" target="_blank" rel="noopener">GitHub<\/a>/);
assert.doesNotMatch(prov, /href="[^"]*\.md"/, 'a .md link survived');
assert.doesNotMatch(prov, /dev-testing-secops-platform|secops-platform\/blob/, 'a link into the private repository survived');
const install = readFileSync(join(out, 'install.html'), 'utf8');
assert.match(install, /<a class="current" href="install\.html">Install<\/a>/);
assert.match(install, /oci:\/\/ghcr\.io\/matelot-io\/charts\/secops-cell/);
assert.match(install, /<li class="d2"><a href="#2-choose-the-cell-s-values">2\. Choose the cell's values<\/a>/, "TOC entry with an apostrophe is not re-escaped");
assert.match(install, /<h2 id="2-choose-the-cell-s-values">/);
assert.match(readFileSync(join(out, 'index.html'), 'utf8'), new RegExp(`Everything about ${PRODUCT}`));

// search index without entities; CLI table rows with an escaped pipe
const index = JSON.parse(readFileSync(join(out, 'search-index.json'), 'utf8'));
assert.equal(index.length, pages.length);
const br = index.find((p) => p.slug === 'backup-restore');
assert.ok(br.headings.includes('What is in an archive'));
assert.doesNotMatch(br.text, /&#39;|&amp;|&lt;/, 'entities in search text');
const cli = readFileSync(join(out, 'cli.html'), 'utf8');
assert.match(cli, /<code>matelot gate --env ID --image REF \| --version V \| --ref SHA<\/code><\/td>/);

// a link to a page that is not in the site is reported with the file and the link
const bad = mkdtempSync(join(tmpdir(), 'docs-bad-'));
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(join(bad, 'examples'), { recursive: true });
writeFileSync(join(bad, 'install.md'), '# Install\n\nSee [the roadmap](roadmap/v1.md) and [the chart](../deploy/helm/secops-cell/values.yaml).\n');
const rb = buildDocs({ docsDir: bad, out: join(bad, 'out'), version: 'latest', checkOnly: true });
assert.equal(rb.problems.length, 2);
assert.match(rb.problems[0], /install\.md: link to "roadmap\/v1\.md" has no page/);
assert.match(rb.problems[1], /private/);
console.log(`docs ok (${pages.length} pages)`);
