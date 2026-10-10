import { releaseLocations } from './evidence.service';

const D = `sha256:${'403ea211'.padEnd(64, '0')}`;
describe('evidence: every registry location of the release digest (audit 1.0.10 #1)', () => {
  it('adds a registry whose tag digest is not synced yet (ACR) from the deployment that ran it', () => {
    const twins = [
      { image: { name: 'docker.io/acme/demo' }, tag: { tag: 'test', digest: D, builtAt: null } },
      { image: { name: 'europe-west3-docker.pkg.dev/p/r/demo' }, tag: { tag: 'staging', digest: D, builtAt: null } },
    ];
    const deps = [
      { d: { imageRef: `matelottest.azurecr.io/demo-service@${D}` } },
      { d: { imageRef: `docker.io/acme/demo@${D}` } },                 // already listed by its tag
      { d: { imageRef: `old.example/demo@sha256:${'a'.repeat(64)}` } }, // other digest: not this release
    ];
    const locs = releaseLocations(twins, deps, [D]);
    expect(locs.map((l) => `${l.image}|${l.source}`)).toEqual(['docker.io/acme/demo|tag', 'europe-west3-docker.pkg.dev/p/r/demo|tag', 'matelottest.azurecr.io/demo-service|deployment']);
    expect(locs[2]!.digest).toBe(D);
  });
});
