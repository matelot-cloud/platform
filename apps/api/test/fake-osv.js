// Fake OSV / KEV / EPSS for offline verification: lodash < 4.17.21 has GHSA-35jh-r3h4-6jhm (CVE-2021-23337, KEV), debug < 4.3.1 has a fake medium.
const http = require('node:http');
const ADV = {
  'GHSA-35jh-r3h4-6jhm': { id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], summary: 'Command Injection in lodash', details: 'lodash versions prior to 4.17.21 are vulnerable to Command Injection via the template function.', published: '2021-05-06T16:09:28Z', modified: '2024-01-01T00:00:00Z', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H' }], affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }], references: [{ type: 'ADVISORY', url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337' }], database_specific: { severity: 'HIGH' } },
  'OSV-FAKE-DEBUG': { id: 'OSV-FAKE-DEBUG', aliases: ['CVE-2099-0001'], summary: 'Fake medium in debug', affected: [{ package: { ecosystem: 'npm', name: 'debug' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.3.5' }] }] }], database_specific: { severity: 'MODERATE' } },
};
function affects(q) {
  const out = [];
  if (q.package.name === 'lodash' && q.version < '4.17.21') out.push({ id: 'GHSA-35jh-r3h4-6jhm' });
  if (q.package.name === 'debug' && q.version < '4.3.5') out.push({ id: 'OSV-FAKE-DEBUG' });
  return out;
}
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/querybatch') { const { queries } = JSON.parse(body); return res.end(JSON.stringify({ results: queries.map((q) => ({ vulns: affects(q) })) })); }
    if (req.url.startsWith('/v1/vulns/')) { const id = decodeURIComponent(req.url.slice(10)); return ADV[id] ? res.end(JSON.stringify(ADV[id])) : (res.statusCode = 404, res.end('{}')); }
    if (req.url.startsWith('/kev')) return res.end(JSON.stringify({ vulnerabilities: [{ cveID: 'CVE-2021-23337', dueDate: '2022-01-01' }] }));
    if (req.url.startsWith('/epss')) { const cves = new URL(req.url, 'http://x').searchParams.get('cve').split(','); return res.end(JSON.stringify({ data: cves.map((c) => ({ cve: c, epss: c === 'CVE-2021-23337' ? '0.0432' : '0.001', percentile: c === 'CVE-2021-23337' ? '0.92' : '0.2' })) })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(8099, () => console.log('fake osv on 8099'));
