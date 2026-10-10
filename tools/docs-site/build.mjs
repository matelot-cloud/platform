#!/usr/bin/env node
// Builds the documentation site from docs/*.md into a static folder the web app serves at /docs/ — every cell carries
// the documentation of the version it runs. Zero runtime dependencies in the output; `marked` renders the Markdown.
//   node tools/docs-site/build.mjs [--out apps/web/public/docs] [--check]   (--check: only verify links, no output)
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// marked is a devDependency of the web app, whose build runs this script
const { marked } = createRequire(join(ROOT, 'apps/web/package.json'))('marked');
const args = process.argv.slice(2);
const OUT = resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'apps/web/public/docs');
const CHECK_ONLY = args.includes('--check');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'apps/web/package.json'), 'utf8')).version;

/** The site: sections → pages (source under docs/, URL slug, title override). Order matters. */
const SITE = [
  { title: 'Start here', pages: [
    { src: 'README.md', slug: 'index', title: 'Documentation', generated: true },
    { src: 'concept-v1.md', slug: 'product', title: 'What the platform does' },
    { src: 'roles.md', slug: 'roles', title: 'Roles and permissions' },
    { src: 'coverage.md', slug: 'coverage', title: 'Service coverage' },
  ] },
  { title: 'CLI and automation', pages: [
    { src: 'cli.md', slug: 'cli', title: 'CLI guide' },
    { src: 'cli-reference.md', slug: 'cli-reference', title: 'Command reference' },
    { src: 'ci-integration.md', slug: 'ci-integration', title: 'CI/CD integration' },
    { src: 'access-tokens.md', slug: 'access-tokens', title: 'Access tokens' },
    { src: 'mcp.md', slug: 'mcp', title: 'MCP server (AI assistants)' },
  ] },
  { title: 'Connections and registries', pages: [
    { src: 'github-app.md', slug: 'github-app', title: 'GitHub App' },
    { src: 'keyless-registries.md', slug: 'keyless-registries', title: 'Keyless registry access' },
    { src: 'release-process.md', slug: 'release-process', title: 'Builds, releases, deployments' },
  ] },
  { title: 'Runners', pages: [
    { src: 'managed-runners.md', slug: 'managed-runners', title: 'Managed runners' },
    { src: 'runner-protocol.md', slug: 'runner-protocol', title: 'Runner protocol' },
  ] },
  { title: 'Operating a cell', pages: [
    { src: 'cell-provisioning.md', slug: 'cell-provisioning', title: 'Provisioning a cell' },
    { src: 'backup-restore.md', slug: 'backup-restore', title: 'Backup and restore' },
    { src: 'usage-and-limits.md', slug: 'usage-and-limits', title: 'Usage and rate limits' },
    { src: 'endpoints.md', slug: 'endpoints', title: 'Endpoints of a cell' },
  ] },
  { title: 'Reference', pages: [
    { src: 'parity-matrix.md', slug: 'parity-matrix', title: 'UI / API / CLI / MCP parity' },
    { src: 'adr/0001-tenancy-and-stack.md', slug: 'adr-0001', title: 'ADR 1: tenancy and stack' },
    { src: 'adr/0002-web-app.md', slug: 'adr-0002', title: 'ADR 2: web app' },
    { src: 'adr/0003-rbac-two-levels.md', slug: 'adr-0003', title: 'ADR 3: two-level RBAC' },
  ] },
];
const PAGES = SITE.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title })));
const bySrc = new Map(PAGES.map((p) => [p.src, p]));
// files other than pages that links may point at: copied verbatim
const ASSETS = ['examples/github-actions.yml', 'examples/gitlab-ci.yml', 'examples/bitbucket-pipelines.yml', 'examples/matelot-config.yaml', 'logo.png'];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The generated landing page: one card per section. */
function indexMarkdown() {
  const lines = ['# Documentation', '', 'Everything about the platform, the CLI and operating a cell — the pages for the version this cell runs.', ''];
  for (const s of SITE) {
    lines.push(`## ${s.title}`, '');
    for (const p of s.pages) if (!p.generated) lines.push(`- [${p.title}](${p.src})`);
    lines.push('');
  }
  return lines.join('\n');
}

const problems = [];
function render(page) {
  const md = page.generated ? indexMarkdown() : readFileSync(join(ROOT, 'docs', page.src), 'utf8');
  const headings = [];
  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens);
    const id = slugify(text);
    if (depth >= 2 && depth <= 3) headings.push({ id, text: text.replace(/<[^>]+>/g, ''), depth });
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${text}</a></h${depth}>\n`;
  };
  renderer.link = ({ href, title, tokens }) => {
    const text = renderer.parser.parseInline(tokens);
    let target = href;
    if (!/^(https?:|mailto:|#)/.test(href)) {
      // a relative link to another doc, an asset, or a repository file
      const [path, hash] = href.split('#');
      const fromDir = dirname(page.src);
      const norm = resolve('/', fromDir, path).slice(1); // path relative to docs/
      const to = bySrc.get(norm);
      if (to) target = `${to.slug}.html${hash ? '#' + hash : ''}`;
      else if (ASSETS.includes(norm)) target = norm;
      else if (path.startsWith('../')) target = `https://github.com/dev-testing-secops-platform/secops-platform/blob/main/${resolve('/docs', fromDir, path).slice(1)}`;
      else problems.push(`${page.src}: link to "${href}" has no page or asset in the site`);
    }
    const ext = /^https?:/.test(target) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${esc(target)}"${title ? ` title="${esc(title)}"` : ''}${ext}>${text}</a>`;
  };
  const html = marked.parse(md, { gfm: true, renderer });
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { html, headings, text };
}

function layout(page, body, headings) {
  const nav = SITE.map((s) => `<li class="section"><span>${esc(s.title)}</span><ul>${s.pages.map((p) => `<li${p.slug === page.slug ? ' class="current"' : ''}><a href="${p.slug}.html">${esc(p.title)}</a></li>`).join('')}</ul></li>`).join('');
  const toc = headings.length > 1 ? `<nav class="toc"><div class="toc-title">On this page</div><ul>${headings.map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></nav>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · Documentation</title>
<link rel="icon" href="logo.png">
<link rel="stylesheet" href="site.css">
</head>
<body>
<header class="top">
  <a class="brand" href="index.html"><img src="logo.png" alt=""><span id="product">Security Platform</span> <span class="dim">docs</span></a>
  <div class="search"><input id="q" type="search" placeholder="Search the docs…" autocomplete="off" aria-label="Search"><div id="results" class="results" hidden></div></div>
  <a class="app" href="/">Open the app →</a>
</header>
<div class="page">
  <button class="nav-toggle" aria-expanded="false" aria-controls="side">Contents</button>
  <nav class="side" id="side"><ul>${nav}</ul></nav>
  <main class="content">
    <div class="crumbs">${esc(page.section)}</div>
    <article>${body}</article>
    <footer>Version ${esc(VERSION)} · generated from <code>docs/${esc(page.src)}</code></footer>
  </main>
  ${toc}
</div>
<script src="site.js" defer></script>
</body>
</html>
`;
}

const CSS = readFileSync(join(ROOT, 'tools/docs-site/site.css'), 'utf8');
const JS = readFileSync(join(ROOT, 'tools/docs-site/site.js'), 'utf8');

const index = [];
const outputs = new Map();
for (const page of PAGES) {
  const { html, headings, text } = render(page);
  outputs.set(`${page.slug}.html`, layout(page, html, headings));
  index.push({ slug: page.slug, title: page.title, section: page.section, headings: headings.map((h) => h.text), text: text.slice(0, 20_000) });
}
for (const src of PAGES.filter((p) => !p.generated).map((p) => p.src)) if (!existsSync(join(ROOT, 'docs', src))) problems.push(`missing source docs/${src}`);
for (const a of ASSETS) if (!existsSync(join(ROOT, 'docs', a))) problems.push(`missing asset docs/${a}`);

if (problems.length) {
  console.error(`docs site: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
if (CHECK_ONLY) { console.log(`docs site: ${PAGES.length} pages, links ok`); process.exit(0); }

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const [name, content] of outputs) writeFileSync(join(OUT, name), content);
writeFileSync(join(OUT, 'site.css'), CSS);
writeFileSync(join(OUT, 'site.js'), JS);
writeFileSync(join(OUT, 'search-index.json'), JSON.stringify(index));
for (const a of ASSETS) { mkdirSync(dirname(join(OUT, a)), { recursive: true }); copyFileSync(join(ROOT, 'docs', a), join(OUT, a)); }
console.log(`docs site: ${PAGES.length} pages → ${OUT}`);
