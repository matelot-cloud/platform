#!/usr/bin/env node
/**
 * Generates a Postman collection (v2.1, also importable in Insomnia / Bruno) and a REST-Client `.http` file
 * with EVERY operation of the running platform, from its OpenAPI document.
 *
 *   SECOPS_URL=http://localhost:3000 node generate-collection.mjs     → secops.postman_collection.json, secops.http
 */
import { writeFileSync } from 'node:fs';
const BASE = (process.env.SECOPS_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const doc = await (await fetch(`${BASE}/api/docs-json`)).json();
const schemas = doc.components?.schemas ?? {};
const PARAMS = ['organizationId', 'workspaceId', 'teamId', 'projectId', 'serviceId', 'environmentId', 'repositoryId', 'integrationId', 'imageId', 'sbomId', 'findingId', 'jobId', 'pipelineId', 'poolId', 'runnerId', 'membershipId', 'tokenId', 'userId', 'id', 'from', 'to'];

// Readable sample values by field name (the schema gives types; these make bodies copy-paste ready).
const FIELD = { version: '1.9.3', imageRef: 'registry.example.com/team/app@sha256:<digest>', commitSha: '<commit sha>', name: 'my-name', slug: 'my-slug', email: 'person@example.com', note: 'reason for the decision', notes: 'release notes', tag: 'v1.9.3', ref: 'main', baseUrl: 'ghcr.io', repositoryUrl: 'git@github.com:acme/app.git', template: 'security', description: '', expiresInDays: 30 };
// Operations whose body is typed inline in the controller (no DTO class).
const EXTRA_BODIES = {
  'post /api/v1/integrations/{integrationId}/ecr/repositories': { name: 'team/app', scanOnPush: true, immutableTags: false },
  'post /api/v1/services/{serviceId}/registries/{integrationId}/repositories': { name: 'team/app', scanOnPush: true },
};

function example(schema, depth = 0, field = '') {
  if (!schema || depth > 4) return null;
  if (schema.$ref) return example(schemas[schema.$ref.split('/').pop()], depth + 1, field);
  if (field in FIELD && (schema.type === 'string' || schema.type === 'number' || schema.type === 'integer')) return FIELD[field];
  if (schema.example !== undefined) return schema.example;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'string': return schema.format === 'uuid' ? '00000000-0000-0000-0000-000000000000' : '';
    case 'integer': case 'number': return schema.minimum ?? 0;
    case 'boolean': return false;
    case 'array': return [];
    default: {
      const out = {};
      // required fields, plus optional ones with a meaningful sample (optional ids are left out rather than faked)
      const required = schema.required ?? [];
      for (const [k, v] of Object.entries(schema.properties ?? {})) if (required.includes(k) || k in FIELD || v.enum) out[k] = example(v, depth + 1, k);
      return out;
    }
  }
}

const folders = new Map();
const httpParts = [`# secops platform API — generated from ${BASE}/api/docs-json\n# Personal access token: user menu → Access tokens. Fill the ids below (Swagger UI: ${BASE}/api/docs).\n@baseUrl = ${BASE}\n@token = spt_REPLACE_ME\n${PARAMS.map((p) => `@${p} = `).join('\n')}\n`];
let count = 0;
for (const [path, item] of Object.entries(doc.paths).sort(([a], [b]) => a.localeCompare(b))) {
  if (path.includes('/runner/') || path.includes('/webhooks/') || path.includes('/registry/token') || path.includes('/registry/events')) continue; // machine-to-machine
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = item[method];
    if (!op) continue;
    count++;
    const tag = op.tags?.[0] ?? 'other';
    const short = path.replace('/api/v1', '');
    const pmPath = path.replace(/\{(\w+)\}/g, '{{$1}}');
    const query = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: '', disabled: !p.required, description: p.description ?? '' }));
    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    const extra = EXTRA_BODIES[`${method} ${path}`];
    const body = extra ? JSON.stringify(extra, null, 2) : bodySchema ? JSON.stringify(example(bodySchema), null, 2) : method === 'get' || method === 'delete' ? null : '{}';
    const request = {
      method: method.toUpperCase(),
      header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: { raw: `{{baseUrl}}${pmPath}`, host: ['{{baseUrl}}'], path: pmPath.split('/').filter(Boolean), query },
      description: [op.summary, op.description].filter(Boolean).join('\n\n'),
      ...(body ? { body: { mode: 'raw', raw: body, options: { raw: { language: 'json' } } } } : {}),
    };
    if (!folders.has(tag)) folders.set(tag, []);
    folders.get(tag).push({ name: `${method.toUpperCase()} ${short}`, request });
    const q = query.filter((x) => !x.disabled).map((x) => `${x.key}=`).join('&');
    httpParts.push(`### ${tag} · ${method.toUpperCase()} ${short}${op.summary ? ` — ${op.summary}` : ''}\n${method.toUpperCase()} {{baseUrl}}${pmPath}${q ? `?${q}` : ''}\nAuthorization: Bearer {{token}}${body ? `\nContent-Type: application/json\n\n${body}` : ''}\n`);
  }
}
const collection = {
  info: { name: 'secops platform API', description: `All user-facing operations of ${BASE} (generated from /api/docs-json). Set the collection variables baseUrl and token (a personal access token, spt_…), then the ids you work with.`, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [{ key: 'baseUrl', value: BASE }, { key: 'token', value: '' }, ...PARAMS.map((p) => ({ key: p, value: '' }))],
  item: [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({ name, item })),
};
writeFileSync('secops.postman_collection.json', JSON.stringify(collection, null, 2));
writeFileSync('secops.http', httpParts.join('\n'));
console.log(`${count} operations in ${folders.size} folders → secops.postman_collection.json, secops.http`);
