import { parsePurl, parseSbom } from './parse';

describe('SBOM parsing', () => {
  it('parses purls', () => {
    expect(parsePurl('pkg:npm/%40scope/name@1.2.3')).toEqual({ type: 'npm', namespace: '@scope', name: 'name', version: '1.2.3' });
    expect(parsePurl('pkg:deb/debian/openssl@3.0.11-1~deb12u2?arch=amd64')).toEqual({ type: 'deb', namespace: 'debian', name: 'openssl', version: '3.0.11-1~deb12u2' });
    expect(parsePurl('pkg:golang/github.com/gin-gonic/gin@v1.9.1')).toEqual({ type: 'golang', namespace: 'github.com/gin-gonic', name: 'gin', version: 'v1.9.1' });
  });

  it('normalises CycloneDX with a dependency graph', () => {
    const doc = {
      bomFormat: 'CycloneDX', specVersion: '1.5',
      metadata: { timestamp: '2026-01-01T00:00:00Z', component: { 'bom-ref': 'root', name: 'app' }, tools: { components: [{ name: 'syft', version: '1.20.0' }] } },
      components: [
        { 'bom-ref': 'a', purl: 'pkg:npm/lodash@4.17.20', name: 'lodash', version: '4.17.20', licenses: [{ license: { id: 'MIT' } }] },
        { 'bom-ref': 'b', purl: 'pkg:npm/minimist@1.2.5', name: 'minimist', version: '1.2.5', licenses: [{ expression: 'MIT OR ISC' }] },
      ],
      dependencies: [{ ref: 'root', dependsOn: ['a'] }, { ref: 'a', dependsOn: ['b'] }],
    };
    const parsed = parseSbom(doc);
    expect(parsed.format).toBe('cyclonedx');
    expect(parsed.tool).toBe('syft 1.20.0');
    expect(parsed.components.map((c) => [c.name, c.direct, c.licenses])).toEqual([['lodash', true, ['MIT']], ['minimist', false, ['MIT OR ISC']]]);
  });

  it('normalises SPDX', () => {
    const doc = {
      spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', creationInfo: { created: '2026-01-01T00:00:00Z', creators: ['Tool: syft-1.20.0'] },
      packages: [
        { SPDXID: 'SPDXRef-root', name: 'app' },
        { SPDXID: 'SPDXRef-1', name: 'openssl', versionInfo: '3.0.11', licenseConcluded: 'Apache-2.0', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:deb/debian/openssl@3.0.11' }] },
      ],
      relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-root' }, { spdxElementId: 'SPDXRef-root', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-1' }],
    };
    const parsed = parseSbom(doc);
    expect(parsed.format).toBe('spdx');
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components[0]).toMatchObject({ name: 'openssl', type: 'deb', direct: true, licenses: ['Apache-2.0'] });
  });

  it('rejects unknown documents', () => {
    expect(() => parseSbom({ hello: 'world' })).toThrow(/CycloneDX or SPDX/);
  });
});
