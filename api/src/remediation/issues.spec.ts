import { createJiraIssue, markdownToAdf, setGithubIssueState, transitionJiraIssue } from './issues';

describe('Jira issue body (ADF) and native fields', () => {
  it('renders **Label:** as strong text, links as links, and keeps paragraphs', () => {
    const doc = markdownToAdf('**Service:** demo\n\n**Severity:** high · EPSS 0.6%\n\nReferences: https://osv.dev/vulnerability/CVE-2026-1');
    const p = doc.content as { type: string; content: { type: string; text: string; marks?: { type: string; attrs?: unknown }[] }[] }[];
    expect(p).toHaveLength(3);
    expect(p[0]!.content[0]).toEqual({ type: 'text', text: 'Service:', marks: [{ type: 'strong' }] });
    expect(p[0]!.content[1]).toEqual({ type: 'text', text: ' demo' });
    expect(p[2]!.content[1]!.marks![0]).toEqual({ type: 'link', attrs: { href: 'https://osv.dev/vulnerability/CVE-2026-1' } });
    expect(JSON.stringify(doc)).not.toContain('**');
  });

  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('sends priority from severity and duedate from the SLA; retries without them when the screen lacks the fields', async () => {
    const bodies: Record<string, { fields: Record<string, unknown> }>[] = [];
    let n = 0;
    global.fetch = (async (_u: string, init?: { body?: string }) => { const b = JSON.parse(init!.body!); bodies.push(b); n++; return n === 1 ? new Response('{"errors":{"priority":"Field \'priority\' cannot be set. It is not on the appropriate screen"}}', { status: 400 }) : new Response(JSON.stringify({ key: 'KAN-8' }), { status: 201 }); }) as typeof fetch;
    const r = await createJiraIssue('https://acme.atlassian.net', 'u', 't', 'KAN', { title: 't', body: '**Service:** demo', severity: 'critical', dueAt: new Date('2026-10-24T12:00:00Z') });
    expect(r.key).toBe('KAN-8');
    expect((bodies[0] as unknown as { fields: Record<string, unknown> }).fields).toMatchObject({ priority: { name: 'Highest' }, duedate: '2026-10-24' });
    expect((bodies[1] as unknown as { fields: Record<string, unknown> }).fields.priority).toBeUndefined();
  });

  it('closing picks the transition whose target is in the done category and comments', async () => {
    const calls: string[] = [];
    global.fetch = (async (u: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${u.replace('https://acme.atlassian.net', '')}${init?.body ? ' ' + init.body : ''}`);
      if (u.endsWith('/transitions') && !init?.method) return new Response(JSON.stringify({ transitions: [{ id: '11', name: 'In Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }, { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }] }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    expect(await transitionJiraIssue('https://acme.atlassian.net', 'u', 't', 'KAN-7', 'close', 'done in Matelot')).toBe('Done');
    expect(calls.some((c) => c.startsWith('POST /rest/api/3/issue/KAN-7/transitions {"transition":{"id":"31"}}'))).toBe(true);
    expect(calls.some((c) => c.startsWith('POST /rest/api/3/issue/KAN-7/comment'))).toBe(true);
  });

  it('GitHub: comment then close with state_reason completed', async () => {
    const calls: string[] = [];
    global.fetch = (async (u: string, init?: { method?: string; body?: string }) => { calls.push(`${init?.method} ${u} ${init?.body}`); return new Response('{}', { status: 200 }); }) as typeof fetch;
    await setGithubIssueState('https://api.github.com', 'tok', 'matelot-org/demo-repo', 1, 'closed', 'done');
    expect(calls[0]).toContain('POST https://api.github.com/repos/matelot-org/demo-repo/issues/1/comments');
    expect(calls[1]).toContain('PATCH https://api.github.com/repos/matelot-org/demo-repo/issues/1 {"state":"closed","state_reason":"completed"}');
  });
});
