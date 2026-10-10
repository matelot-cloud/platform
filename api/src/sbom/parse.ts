/**
 * Normalizes CycloneDX (1.4–1.6) and SPDX 2.x JSON into one component list.
 * Only what the platform needs: purl, name/version/type, licenses, direct/transitive, locations.
 */
export interface ParsedComponent {
  purl: string;
  type: string;
  namespace: string | null;
  name: string;
  version: string | null;
  licenses: string[];
  locations: string[];
  direct: boolean | null;
}

export interface ParsedSbom {
  format: 'cyclonedx' | 'spdx';
  specVersion: string | null;
  tool: string | null;
  generatedAt: string | null;
  rootName: string | null;
  components: ParsedComponent[];
}

/** purl → type / namespace / name / version (no full URL decoding beyond what we need). */
export function parsePurl(purl: string): { type: string; namespace: string | null; name: string; version: string | null } {
  const noScheme = purl.replace(/^pkg:/, '');
  const [pathPart] = noScheme.split('?');
  const [beforeVersion, version] = pathPart.split('@');
  const segments = beforeVersion.split('/');
  const type = segments.shift() ?? 'generic';
  const name = decodeURIComponent(segments.pop() ?? '');
  const namespace = segments.length ? decodeURIComponent(segments.join('/')) : null;
  return { type, namespace, name, version: version ? decodeURIComponent(version) : null };
}

function cdxLicenses(c: { licenses?: { license?: { id?: string; name?: string }; expression?: string }[] }): string[] {
  const out = new Set<string>();
  for (const l of c.licenses ?? []) {
    if (l.expression) out.add(l.expression);
    else if (l.license?.id) out.add(l.license.id);
    else if (l.license?.name) out.add(l.license.name);
  }
  return [...out];
}

export function parseSbom(doc: unknown): ParsedSbom {
  const d = doc as Record<string, unknown>;
  if (d.bomFormat === 'CycloneDX' || Array.isArray(d.components)) return parseCycloneDx(d);
  if (typeof d.spdxVersion === 'string' || Array.isArray(d.packages)) return parseSpdx(d);
  throw new Error('Unrecognised SBOM: expected CycloneDX or SPDX JSON');
}

function parseCycloneDx(d: Record<string, unknown>): ParsedSbom {
  type Cdx = { 'bom-ref'?: string; purl?: string; name?: string; version?: string; type?: string; group?: string; licenses?: never[]; properties?: { name: string; value: string }[]; evidence?: { occurrences?: { location: string }[] } };
  const metadata = (d.metadata ?? {}) as { component?: Cdx; timestamp?: string; tools?: { components?: { name: string; version?: string }[]; name?: string; version?: string } | { name: string; version?: string }[] };
  const list = (d.components ?? []) as Cdx[];
  const deps = (d.dependencies ?? []) as { ref: string; dependsOn?: string[] }[];
  const rootRef = metadata.component?.['bom-ref'];
  const directRefs = new Set(rootRef ? (deps.find((x) => x.ref === rootRef)?.dependsOn ?? []) : []);
  const hasGraph = deps.length > 0 && !!rootRef;
  const toolsRaw = metadata.tools;
  const toolList = Array.isArray(toolsRaw) ? toolsRaw : (toolsRaw?.components ?? []);
  const tool = toolList.length ? toolList.map((t) => `${t.name}${t.version ? ` ${t.version}` : ''}`).join(', ') : null;
  const components: ParsedComponent[] = [];
  const seen = new Set<string>();
  const walk = (items: Cdx[]) => {
    for (const c of items) {
      // Files and unidentifiable entries are scanner bookkeeping, not software components.
      if (c.type === 'file' || !c.purl) continue;
      const purl = c.purl;
      if (seen.has(purl)) continue;
      seen.add(purl);
      const p = parsePurl(purl);
      const locations = [...new Set([...(c.evidence?.occurrences ?? []).map((o) => o.location), ...(c.properties ?? []).filter((x) => x.name.endsWith(':location:path')).map((x) => x.value)])].slice(0, 10);
      components.push({ purl, type: p.type, namespace: p.namespace, name: p.name, version: p.version, licenses: cdxLicenses(c as never), locations, direct: hasGraph ? directRefs.has(c['bom-ref'] ?? '') : null });
      const nested = (c as { components?: Cdx[] }).components;
      if (nested?.length) walk(nested);
    }
  };
  walk(list);
  return { format: 'cyclonedx', specVersion: typeof d.specVersion === 'string' ? d.specVersion : null, tool, generatedAt: metadata.timestamp ?? null, rootName: metadata.component?.name ?? null, components };
}

function parseSpdx(d: Record<string, unknown>): ParsedSbom {
  type Pkg = { SPDXID: string; name: string; versionInfo?: string; licenseConcluded?: string; licenseDeclared?: string; externalRefs?: { referenceType: string; referenceLocator: string }[] };
  const pkgs = (d.packages ?? []) as Pkg[];
  const rels = (d.relationships ?? []) as { spdxElementId: string; relationshipType: string; relatedSpdxElement: string }[];
  const docId = String(d.SPDXID ?? 'SPDXRef-DOCUMENT');
  const roots = new Set(rels.filter((r) => r.spdxElementId === docId && r.relationshipType === 'DESCRIBES').map((r) => r.relatedSpdxElement));
  const direct = new Set(rels.filter((r) => roots.has(r.spdxElementId) && r.relationshipType === 'DEPENDS_ON').map((r) => r.relatedSpdxElement));
  const hasGraph = rels.some((r) => r.relationshipType === 'DEPENDS_ON');
  const creators = ((d.creationInfo ?? {}) as { creators?: string[]; created?: string });
  const components: ParsedComponent[] = [];
  const seen = new Set<string>();
  for (const p of pkgs) {
    if (roots.has(p.SPDXID)) continue;
    const purl = p.externalRefs?.find((r) => r.referenceType === 'purl')?.referenceLocator ?? `pkg:generic/${encodeURIComponent(p.name)}${p.versionInfo ? `@${encodeURIComponent(p.versionInfo)}` : ''}`;
    if (seen.has(purl)) continue;
    seen.add(purl);
    const parsed = parsePurl(purl);
    const lic = [p.licenseConcluded, p.licenseDeclared].filter((x): x is string => !!x && x !== 'NOASSERTION' && x !== 'NONE');
    components.push({ purl, ...parsed, licenses: [...new Set(lic)], locations: [], direct: hasGraph ? direct.has(p.SPDXID) : null });
  }
  return { format: 'spdx', specVersion: typeof d.spdxVersion === 'string' ? d.spdxVersion : null, tool: creators.creators?.filter((c) => c.startsWith('Tool:')).map((c) => c.slice(5).trim()).join(', ') || null, generatedAt: creators.created ?? null, rootName: pkgs.find((p) => roots.has(p.SPDXID))?.name ?? null, components };
}
