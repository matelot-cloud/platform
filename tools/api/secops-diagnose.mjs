#!/usr/bin/env node
/**
 * secops-diagnose — explains how releases, images and environments are (or are not) linked for a service.
 *
 *   export SECOPS_URL=http://localhost:3000 SECOPS_TOKEN=spt_…      (sudo token recommended)
 *   node secops-diagnose.mjs                    # every service with deployments
 *   node secops-diagnose.mjs --service demo     # by name, slug or id
 */
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = (process.env.SECOPS_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.SECOPS_TOKEN ?? '';
if (!BASE || !TOKEN) { console.error('Set SECOPS_URL and SECOPS_TOKEN'); process.exit(2); }
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
async function get(path) {
  const r = await fetch(`${BASE}/api/v1${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
const short = (s, n = 12) => (s ? String(s).slice(0, n) : '—');
const digestOf = (ref) => (ref && ref.includes('@sha256:') ? ref.split('@')[1] : null);
const ago = (d) => { if (!d) return '—'; const m = Math.round((Date.now() - new Date(d).getTime()) / 60000); return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

(async () => {
  const me = await get('/me');
  const orgs = await get('/organizations');
  const org = flag('org') ?? orgs[0]?.id;
  const services = await get(`/organizations/${org}/services`);
  const want = flag('service');
  const selected = want ? services.filter((s) => s.id === want || s.slug === want || s.name.toLowerCase() === want.toLowerCase()) : services;
  if (!selected.length) { console.error(`no service "${want}". Services: ${services.map((s) => `${s.name} (${s.slug})`).join(', ')}`); process.exit(2); }
  console.log(`${c('1', 'secops diagnose')} · ${BASE} · as ${me.user?.email}${me.user?.platformRole === 'admin' ? ' (admin)' : ''}`);
  let totalProblems = 0;

  for (const svc of selected) {
    const [inv, dep, images, releases] = await Promise.all([get(`/services/${svc.id}/inventory`), get(`/services/${svc.id}/deployments`), get(`/services/${svc.id}/images`), get(`/services/${svc.id}/releases`)]);
    if (!want && !dep.history?.length) continue;
    const problems = [];
    const tags = images.flatMap((img) => (img.tags ?? []).map((t) => ({ ...t, image: img.name, imageId: img.id, integrationId: img.integrationId, lastError: img.lastError, lastSyncedAt: img.lastSyncedAt })));
    const tagById = new Map(tags.map((t) => [t.id, t]));
    const relById = new Map(releases.map((r) => [r.id, r]));
    const relByVersion = new Map(releases.map((r) => [r.version, r]));

    console.log(`\n${c('36', `══ ${svc.name}`)} ${c('2', `(${svc.slug} · ${svc.id})`)}`);

    // Environments: what runs now and how it is linked
    console.log(c('1', '\n  Environments (current deployment)'));
    for (const e of dep.environments ?? []) {
      const d = e.current;
      if (!d) { console.log(`   ${e.name.padEnd(12)} ${c('2', 'nothing deployed')}`); continue; }
      const t = d.imageTagId ? tagById.get(d.imageTagId) : null;
      const rel = d.releaseId ? relById.get(d.releaseId) : null;
      const dg = t?.digest ?? digestOf(d.imageRef);
      const sameDigest = dg ? tags.filter((x) => x.digest === dg) : [];
      console.log(`   ${e.name.padEnd(12)} version ${String(d.version ?? '—').padEnd(12)} release ${rel ? c('32', rel.version) : c('31', 'NOT LINKED')}  image ${t ? c('32', `${t.image.split('/').slice(-1)[0]}:${short(t.tag, 20)}`) : c('31', 'NOT LINKED')}  ${c('2', `${d.source} · ${ago(d.deployedAt)}`)}`);
      console.log(c('2', `                ref ${d.imageRef ?? '—'}`));
      if (d.version && !d.releaseId) {
        const exists = relByVersion.get(String(d.version).replace(/^v(?=\d)/, ''));
        problems.push(exists
          ? `${e.name}: deployment names version ${d.version}, release ${exists.version} exists but is not linked (deployment recorded before the release existed; re-run the deploy step or wait for the back-fill).`
          : `${e.name}: deployment names version ${d.version} but no release was created → the deploy ran with a CLI older than 1.6.0 on the GitHub runner, or an API older than the release-linkage fix. Check \`secops --version\` on the runner and redeploy.`);
      }
      if (d.imageRef && !d.imageTagId) {
        problems.push(sameDigest.length
          ? `${e.name}: reported by digest; the tag with that digest exists (${sameDigest.map((x) => `${x.image.split('/').slice(-1)[0]}:${short(x.tag, 20)}`).join(', ')}) but the deployment is not attached yet → next sync of that image attaches it (Container images → Sync tags).`
          : `${e.name}: image ${d.imageRef} is unknown to the platform (no tag with digest ${short(dg, 19)}): the image's registry has not been read → Container images → Sync tags on ${d.imageRef.split('@')[0].split(':')[0]}; if it shows an error, check its registry connection.`);
      }
      if (d.imageTagId && dg && !(inv.environments ?? []).find((x) => x.id === e.id)?.current?.sbom) problems.push(`${e.name}: the image running here has no SBOM → no findings for this environment. Generate it (Container images → Generate SBOM) or check the runner / Jobs.`);
    }

    // Releases and their images
    console.log(c('1', '\n  Releases'));
    for (const r of releases.slice(0, 8)) {
      const ir = (inv.releases ?? []).find((x) => x.id === r.id);
      const imgs = ir?.images ?? [];
      const envs = ir?.environments ?? [];
      console.log(`   ${r.version.padEnd(14)} ${c('2', `${r.source} · commit ${short(r.commitSha, 10)} · ${ago(r.createdAt)}`)}  images ${imgs.length ? c('32', imgs.length) : c('33', 0)}  runs in ${envs.length ? c('32', envs.map((x) => x.name).join(', ')) : c('2', '—')}`);
      const versionTags = tags.filter((t) => t.tag.replace(/^v(?=\d)/, '') === r.version && t.releaseId !== r.id);
      if (versionTags.length) problems.push(`release ${r.version}: tags named ${r.version} exist but are not linked to it (${versionTags.map((t) => t.image.split('/')[0]).join(', ')}) → matching runs on the next tag sync of those images.`);
      if (!r.commitSha) problems.push(`release ${r.version}: no commit — created before \`--commit\` / SECOPS_COMMIT was passed, or recorded by hand. Images named by commit cannot link to it.`);
    }
    if (!releases.length) console.log(c('2', '   none'));

    // Images and registry health
    console.log(c('1', '\n  Images (registries)'));
    for (const img of images) {
      const synced = img.lastSyncedAt ? ago(img.lastSyncedAt) : 'never';
      console.log(`   ${img.name}  ${c('2', `${img.tags?.length ?? 0} tags · synced ${synced}${img.integrationId ? '' : ' · no registry connection'}`)}${img.lastError ? `  ${c('31', img.lastError)}` : ''}`);
      if (img.lastError) problems.push(`image ${img.name}: last sync failed — ${img.lastError}. Tags/digests from this registry are stale, so deployments reported by digest cannot link.`);
      if (!img.lastSyncedAt) problems.push(`image ${img.name}: never synced → no tags/digests known yet (Sync tags).`);
      const builtIn = /^localhost(:\d+)?\//.test(img.name) || img.name.startsWith(`${(BASE.split('//')[1] ?? '').split(':')[0]}`);
      if (!img.integrationId && !builtIn && img.lastError) problems.push(`image ${img.name}: no registry connection attached, so private tags cannot be read → connect the registry (Integrations) at the project/workspace of this service, then Remove + re-add the image (or deploy again) so it picks up the connection.`);
    }
    if (!images.length) console.log(c('2', '   none'));

    // Recent history
    console.log(c('1', '\n  Last deployments'));
    for (const h of (dep.history ?? []).slice(0, 8)) console.log(`   ${ago(h.deployedAt).padEnd(8)} ${String(h.environmentName).padEnd(12)} ${String(h.version ?? '—').padEnd(14)} release ${h.releaseId ? 'linked' : c('33', 'none  ')}  image ${h.imageTagId ? 'linked' : c('33', 'none  ')}  ${c('2', h.source)}${h.supersededAt ? c('2', ' · superseded') : ''}`);

    console.log(c('1', `\n  Problems (${problems.length})`));
    if (!problems.length) console.log(c('32', '   none — every current deployment is linked to its release and image'));
    for (const p of [...new Set(problems)]) console.log(`   ${c('31', '•')} ${p}`);
    totalProblems += new Set(problems).size;
  }
  console.log(`\n${totalProblems ? c('31', `${totalProblems} problem(s) found`) : c('32', 'no problems found')}\n`);
  process.exit(totalProblems ? 1 : 0);
})().catch((e) => { console.error(c('31', e.message)); process.exit(2); });
