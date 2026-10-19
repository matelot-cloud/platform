#!/usr/bin/env node
/**
 * Every favicon / app icon of the web app from the sources in apps/web/public — never a hand resample:
 *   favicon.svg        → favicon.ico (16, 32, 48 px frames, each rendered at its size; the 16 px frame with the
 *                        thicker strokes the SVG declares in data-small-stroke and without data-small="hide" details),
 *                        favicon-32.png; docs/branding/favicon-review.png shows the 16 / 32 px frames in both schemes
 *   logo-512.png       → apple-touch-icon.png (180), icon-192.png, icon-512.png (the full cap, large sizes only)
 * The Keycloak login theme (deploy/helm/secops-cell/files/theme/matelot/login/resources/img) gets the same favicon.svg,
 * favicon.ico, favicon-32.png and apple-touch-icon.png; chart-test fails when they differ from apps/web/public.
 *
 *   node tools/icons/build.mjs            regenerate (pnpm icons:build)
 *   node tools/icons/build.mjs --check    exit 1 when a committed file differs from what the sources render
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = join(ROOT, 'apps/web/public');
const THEME_IMG = join(ROOT, 'deploy/helm/secops-cell/files/theme/matelot/login/resources/img');
const THEME_COPY_IMG = join(ROOT, 'deploy/compose/init/theme/matelot/login/resources/img');
const check = process.argv.includes('--check');

const svg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
const logo = readFileSync(join(PUBLIC, 'logo-512.png'));

/** The SVG as rendered for the 16 px frame: strokes from data-small-stroke, elements marked data-small="hide" dropped. */
export function smallVariant(source) {
  return source
    .replace(/<[^>]*data-small="hide"[^>]*\/>/g, '')
    .replace(/<([a-z]+)([^>]*)data-small-stroke="([^"]+)"([^>]*)\/>/g, (_, tag, a, w, b) => `<${tag}${a}stroke-width="${w}"${b}/>`);
}

/** Rasterises the SVG at `size` with the colour scheme forced (sharp has no prefers-color-scheme: strip the media rule). */
async function renderSvg(source, size, scheme = 'light') {
  let s = source;
  if (scheme === 'dark') {
    const m = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\s*\}/.exec(s);
    if (m) s = s.replace(/<style>[\s\S]*?<\/style>/, `<style>${m[1]}</style>`);
  } else {
    s = s.replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\s*\}/, '');
  }
  return sharp(Buffer.from(s), { density: (72 * size) / 32 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

/** An .ico holding PNG-encoded frames (every browser since Vista reads PNG frames). */
export function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir[e] = size === 256 ? 0 : size; dir[e + 1] = size === 256 ? 0 : size; dir[e + 2] = 0; dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6); dir.writeUInt32LE(png.length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

async function build() {
  const out = {};
  const f16 = await renderSvg(smallVariant(svg), 16);
  const f32 = await renderSvg(svg, 32);
  const f48 = await renderSvg(svg, 48);
  out['favicon.ico'] = ico([{ size: 16, png: f16 }, { size: 32, png: f32 }, { size: 48, png: f48 }]);
  out['favicon-32.png'] = f32;
  out['apple-touch-icon.png'] = await sharp(logo).resize(180, 180, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
  out['icon-192.png'] = await sharp(logo).resize(192, 192, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
  out['icon-512.png'] = logo;
  // the review strip for docs/branding.md: 16 and 32 px frames, light and dark scheme, at 8× so the pixels show
  const dark16 = await renderSvg(smallVariant(svg), 16, 'dark');
  const dark32 = await renderSvg(svg, 32, 'dark');
  out['favicon-review.png'] = await reviewStrip([{ png: f16, size: 16, bg: '#f3f4f6' }, { png: f32, size: 32, bg: '#f3f4f6' }, { png: dark16, size: 16, bg: '#202124' }, { png: dark32, size: 32, bg: '#202124' }]);
  return out;
}

async function reviewStrip(cells) {
  const scale = 8, pad = 16, cell = 48 * scale;
  const composites = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const big = await sharp(c.png).resize(c.size * scale, c.size * scale, { kernel: 'nearest' }).png().toBuffer();
    const tile = await sharp({ create: { width: cell, height: cell, channels: 4, background: c.bg } }).composite([{ input: big, left: Math.round((cell - c.size * scale) / 2), top: Math.round((cell - c.size * scale) / 2) }]).png().toBuffer();
    composites.push({ input: tile, left: pad + i * (cell + pad), top: pad });
  }
  return sharp({ create: { width: pad + cells.length * (cell + pad), height: cell + 2 * pad, channels: 4, background: '#ffffff' } }).composite(composites).png().toBuffer();
}

/** Pixel comparison (PNG bytes can differ between libvips builds; the picture must not). */
async function samePixels(a, b) {
  if (!a || !b) return false;
  if (a.equals(b)) return true;
  try {
    const [x, y] = await Promise.all([sharp(a).raw().toBuffer({ resolveWithObject: true }), sharp(b).raw().toBuffer({ resolveWithObject: true })]);
    return x.info.width === y.info.width && x.info.height === y.info.height && x.data.equals(y.data);
  } catch { return false; }
}

const targets = (name) => [join(PUBLIC, name), ...(['favicon.ico', 'favicon-32.png', 'apple-touch-icon.png'].includes(name) ? [join(THEME_IMG, name), join(THEME_COPY_IMG, name)] : []), ...(name === 'favicon-review.png' ? [join(ROOT, 'docs/branding/favicon-review.png')] : [])].filter((p) => name !== 'favicon-review.png' || p.includes('docs/'));

const out = await build();
let dirty = [];
for (const [name, buf] of Object.entries(out)) {
  for (const path of targets(name)) {
    const current = existsSync(path) ? readFileSync(path) : null;
    const same = name.endsWith('.ico') ? !!current && current.equals(buf) : await samePixels(current, buf);
    if (same) continue;
    dirty.push(path.replace(ROOT + '/', ''));
    if (!check) writeFileSync(path, buf);
  }
}
// the SVG itself is copied into the theme (same file, so the login page and the app share one favicon)
for (const path of [join(THEME_IMG, 'favicon.svg'), join(THEME_COPY_IMG, 'favicon.svg')]) {
  if (existsSync(path) && readFileSync(path, 'utf8') === svg) continue;
  dirty.push(path.replace(ROOT + '/', ''));
  if (!check) writeFileSync(path, svg);
}
if (check) {
  if (dirty.length) { console.error(`icons out of date (run pnpm --filter @secops/icons build):\n  ${dirty.join('\n  ')}`); process.exit(1); }
  console.log('icons up to date');
} else {
  console.log(dirty.length ? `icons written:\n  ${dirty.join('\n  ')}` : 'icons already up to date');
  const tmp = mkdtempSync(join(tmpdir(), 'icons-'));
  writeFileSync(join(tmp, 'favicon-32.png'), out['favicon-32.png']);
  console.log(`32 px frame for a look: ${tmp}/favicon-32.png · review strip: docs/branding/favicon-review.png`);
}
