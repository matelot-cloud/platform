/** OpenVEX (https://github.com/openvex/spec) document from Matelot findings and decisions. */

export interface VexInput {
  author: string;
  product: { purl: string; identifiers?: Record<string, string> }[];
  timestamp: string;
  findings: { advisory: string; aliases: string[]; component: string; purl: string | null; status: 'open' | 'fixed' | 'fixed_later' | 'accepted' | 'false_positive' | 'not_affected'; note: string | null; fixedVersion: string | null; statusChangedAt: string | null }[];
}

const JUSTIFICATIONS = ['component_not_present', 'vulnerable_code_not_present', 'vulnerable_code_not_in_execute_path', 'vulnerable_code_cannot_be_controlled_by_adversary', 'inline_mitigations_already_exist'];

export function buildOpenVex(input: VexInput) {
  const statements = input.findings.map((f) => {
    const base = { vulnerability: { name: f.advisory, aliases: f.aliases.filter((a) => a !== f.advisory) }, products: input.product.map((p) => ({ '@id': p.purl, identifiers: p.identifiers, subcomponents: f.purl ? [{ '@id': f.purl }] : [] })), timestamp: f.statusChangedAt ?? input.timestamp };
    switch (f.status) {
      case 'fixed_later': // the component was in THIS release; it left the service later → this product IS affected
        return { ...base, status: 'affected', action_statement: `Affected in this version; no longer present in later builds${f.fixedVersion ? ` (fix ${f.fixedVersion})` : ''}`, ...(f.note ? { status_notes: f.note } : {}), ...(f.statusChangedAt ? { action_statement_timestamp: f.statusChangedAt } : {}) };
      case 'fixed':
        return { ...base, status: 'fixed', ...(f.note ? { status_notes: f.note } : {}), ...(f.fixedVersion ? { action_statement: `fixed in ${f.fixedVersion}` } : {}) };
      case 'not_affected': {
        const j = JUSTIFICATIONS.find((x) => (f.note ?? '').toLowerCase().includes(x.replace(/_/g, ' '))) ?? 'vulnerable_code_not_in_execute_path';
        return { ...base, status: 'not_affected', justification: j, impact_statement: f.note ?? 'Not affected as assessed by the product security team.' };
      }
      case 'false_positive':
        return { ...base, status: 'not_affected', justification: 'component_not_present', impact_statement: f.note ?? 'False positive: the vulnerable component is not present in the product.' };
      case 'accepted':
        return { ...base, status: 'affected', action_statement: `Risk accepted: ${f.note ?? 'documented decision'}`, action_statement_timestamp: f.statusChangedAt ?? input.timestamp };
      default:
        return { ...base, status: 'under_investigation', ...(f.fixedVersion ? { action_statement: `Upgrade to ${f.fixedVersion}` } : {}) };
    }
  });
  // One statement per (vulnerability, status, justification) listing every affected subcomponent.
  const merged = new Map<string, (typeof statements)[number]>();
  for (const st of statements) {
    const k = `${st.vulnerability.name}|${st.status}|${(st as { justification?: string }).justification ?? ''}`;
    const cur = merged.get(k);
    if (!cur) { merged.set(k, JSON.parse(JSON.stringify(st))); continue; }
    for (const [i, p] of st.products.entries()) {
      const target = cur.products[i] as { subcomponents?: { '@id': string }[] };
      const add = (p as { subcomponents?: { '@id': string }[] }).subcomponents ?? [];
      target.subcomponents = [...new Map([...(target.subcomponents ?? []), ...add].map((x) => [x['@id'], x])).values()];
    }
    cur.vulnerability.aliases = [...new Set([...cur.vulnerability.aliases, ...st.vulnerability.aliases])];
  }
  return {
    '@context': 'https://openvex.dev/ns/v0.2.0',
    '@id': `https://matelot.local/vex/${input.timestamp}`,
    author: input.author,
    role: 'Product security',
    timestamp: input.timestamp,
    version: 1,
    tooling: 'Matelot',
    statements: [...merged.values()],
  };
}
