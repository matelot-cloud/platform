#!/usr/bin/env node
// Renders docs/*.md into one version folder of the public website (matelot-cloud/website → docs/<version>/).
//   node tools/docs-site/build.mjs [--docs docs] [--out ../website/docs/latest] [--version latest] [--check]
// The release workflow runs it for `docs/vX.Y/` and `docs/latest/`, the main-branch sync for `latest`, CI with --check.
// The output has zero runtime dependencies; `marked` (a web-app devDependency) renders the Markdown. The product name
// and the public links are build-time constants (PRODUCT, PUBLIC below).
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { marked } = createRequire(join(ROOT, 'apps/web/package.json'))('marked');
const HERE = dirname(fileURLToPath(import.meta.url));

/** The site: sections → pages (source under docs/, URL slug, title). Order matters. */
export const SITE = [
  { title: 'Start here', pages: [
    { src: 'README.md', slug: 'index', title: 'Documentation', generated: true },
    { src: 'install.md', slug: 'install', title: 'Install Matelot' },
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
    { src: 'builds-releases-deployments.md', slug: 'builds-releases-deployments', title: 'Builds, releases, deployments' },
  ] },
  { title: 'Runners', pages: [
    { src: 'managed-runners.md', slug: 'managed-runners', title: 'Managed runners' },
    { src: 'runner-protocol.md', slug: 'runner-protocol', title: 'Runner protocol' },
  ] },
  { title: 'Operating a cell', pages: [
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
// files other than pages that links may point at: copied verbatim
const ASSETS = ['examples/github-actions.yml', 'examples/gitlab-ci.yml', 'examples/bitbucket-pipelines.yml', 'examples/matelot-config.yaml'];
/** Build-time constants: the product name and where the public site points. */
export const PRODUCT = 'Matelot';
export const ORG = 'matelot-cloud'; // the GitHub organization: the one place it is named in the generator
export const PUBLIC = { github: `https://github.com/${ORG}/matelot`, releases: `https://github.com/${ORG}/matelot/releases` };

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const unescapeHtml = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Build one version of the docs.
 * @param {object} o
 * @param {string} o.docsDir   the docs/ folder to render (a checkout of a tag, or the working tree)
 * @param {string} o.out       output folder (…/docs/<version>)
 * @param {string} o.version   'latest' or a tag such as 'v1.2.0'
 * @param {string} [o.product] product name (build-time constant, PRODUCT)
 * @param {string} o.siteRoot  relative path from the output folder to the site root (for the logo, landing links)
 * @param {boolean} [o.checkOnly]
 * @returns {{ pages: number, problems: string[] }}
 */
export function buildDocs({ docsDir, out, version, product = PRODUCT, siteRoot = '../..', checkOnly = false }) {
  // pages whose source exists in this docs/ (an old tag may not have every page yet)
  const site = SITE.map((s) => ({ ...s, pages: s.pages.filter((p) => p.generated || existsSync(join(docsDir, p.src))) })).filter((s) => s.pages.length);
  const pages = site.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title })));
  const bySrc = new Map(pages.map((p) => [p.src, p]));
  const assets = ASSETS.filter((a) => existsSync(join(docsDir, a)));
  const problems = [];

  const indexMarkdown = () => {
    const lines = ['# Documentation', '', `Everything about ${product}, the CLI and operating a cell. Version: **${version}**.`, ''];
    for (const s of site) {
      lines.push(`## ${s.title}`, '');
      for (const p of s.pages) if (!p.generated) lines.push(`- [${p.title}](${p.src})`);
      lines.push('');
    }
    return lines.join('\n');
  };

  const render = (page) => {
    const md = page.generated ? indexMarkdown() : readFileSync(join(docsDir, page.src), 'utf8');
    const headings = [];
    const renderer = new marked.Renderer();
    renderer.heading = ({ tokens, depth }) => {
      const text = renderer.parser.parseInline(tokens);
      const plain = unescapeHtml(text.replace(/<[^>]+>/g, '')); // marked escapes ' as &#39;: ids and the TOC use the plain text
      const id = slugify(plain);
      if (depth >= 2 && depth <= 3) headings.push({ id, text: plain, depth });
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${text}</a></h${depth}>\n`;
    };
    renderer.link = ({ href, title, tokens }) => {
      const text = renderer.parser.parseInline(tokens);
      let target = href;
      if (!/^(https?:|mailto:|#)/.test(href)) {
        const [path, hash] = href.split('#');
        const fromDir = dirname(page.src);
        const norm = resolve('/', fromDir, path).slice(1); // relative to docs/
        const to = bySrc.get(norm);
        if (to) target = `${to.slug}.html${hash ? '#' + hash : ''}`;
        else if (assets.includes(norm)) target = norm;
        else problems.push(`${page.src}: link to "${href}" has no page or asset in the site${path.startsWith('../') ? ' (the platform repository is private: public docs cannot link into it)' : ''}`);
      }
      const ext = /^https?:/.test(target) ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${esc(target)}"${title ? ` title="${esc(title)}"` : ''}${ext}>${text}</a>`;
    };
    const html = marked.parse(md, { gfm: true, renderer });
    const text = unescapeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return { html, headings, text };
  };

  const layout = (page, body, headings) => {
    const nav = site.map((s) => `<li class="section"><span>${esc(s.title)}</span><ul>${s.pages.map((p) => `<li${p.slug === page.slug ? ' class="current"' : ''}><a href="${p.slug}.html">${esc(p.title)}</a></li>`).join('')}</ul></li>`).join('');
    const toc = headings.length > 1 ? `<nav class="toc"><div class="toc-title">On this page</div><ul>${headings.map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></nav>` : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · ${esc(product)} docs</title>
<link rel="icon" href="${siteRoot}/assets/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="site.css">
<meta name="docs-version" content="${esc(version)}">
</head>
<body>
<header class="top">
  <a class="brand" href="${siteRoot}/"><img src="${siteRoot}/assets/logo.png" alt="">${esc(product)}<span class="dim">docs</span></a>
  <nav class="top-links"><a href="${siteRoot}/">Home</a><a${page.slug === 'install' ? '' : ' class="current"'} href="index.html">Docs</a><a${page.slug === 'install' ? ' class="current"' : ''} href="install.html">Install</a><a href="${PUBLIC.github}" target="_blank" rel="noopener">GitHub</a></nav>
  <div class="search"><input id="q" type="search" placeholder="Search the docs…" autocomplete="off" aria-label="Search"><div id="results" class="results" hidden></div></div>
  <label class="version"><span class="sr-only">Version</span><select id="version" aria-label="Documentation version"><option value="${esc(version)}">${esc(version)}</option></select></label>
</header>
<div class="page">
  <button class="nav-toggle" aria-expanded="false" aria-controls="side">Contents</button>
  <nav class="side" id="side"><ul>${nav}</ul></nav>
  <main class="content">
    <div class="crumbs">${esc(page.section)}</div>
    <article>${body}</article>
    <footer>${esc(product)} documentation · ${esc(version)} · <a href="${siteRoot}/">home</a> · <a href="${PUBLIC.github}/discussions" target="_blank" rel="noopener">questions</a> · <a href="${PUBLIC.releases}" target="_blank" rel="noopener">releases</a></footer>
  </main>
  ${toc}
</div>
<script src="site.js" defer></script>
</body>
</html>
`;
  };

  const index = [];
  const outputs = new Map();
  for (const page of pages) {
    const { html, headings, text } = render(page);
    outputs.set(`${page.slug}.html`, layout(page, html, headings));
    index.push({ slug: page.slug, title: page.title, section: page.section, headings: headings.map((h) => h.text), text: text.slice(0, 20_000) });
  }
  if (problems.length || checkOnly) return { pages: pages.length, problems };

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, content] of outputs) writeFileSync(join(out, name), content);
  writeFileSync(join(out, 'site.css'), readFileSync(join(HERE, 'site.css'), 'utf8'));
  writeFileSync(join(out, 'site.js'), readFileSync(join(HERE, 'site.js'), 'utf8'));
  writeFileSync(join(out, 'search-index.json'), JSON.stringify(index));
  for (const a of assets) { mkdirSync(dirname(join(out, a)), { recursive: true }); copyFileSync(join(docsDir, a), join(out, a)); }
  return { pages: pages.length, problems };
}

// ---- CLI --------------------------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const out = opt('--out', 'dist/docs/latest');
  const r = buildDocs({ docsDir: resolve(ROOT, opt('--docs', 'docs')), out: resolve(ROOT, out), version: opt('--version', 'latest'), checkOnly: args.includes('--check') });
  if (r.problems.length) { console.error(`docs: ${r.problems.length} problem(s)`); for (const p of r.problems) console.error(`  ${p}`); process.exit(1); }
  console.log(`docs: ${r.pages} pages${args.includes('--check') ? ', links ok' : ` → ${out}`}`);
}
