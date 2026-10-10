/** External issue creation: GitHub Issues and Jira Cloud (REST v3). Pure HTTP helpers, no platform state. */

export interface IssueDraft { title: string; body: string; labels?: string[]; severity?: 'critical' | 'high' | 'medium' | 'low' | 'unknown'; dueAt?: Date | null }
export interface CreatedIssue { provider: 'github' | 'gitlab' | 'bitbucket' | 'jira'; key: string; url: string; nodeId?: string; board?: string }

export async function createGithubIssue(apiUrl: string, token: string, repoFullName: string, draft: IssueDraft): Promise<CreatedIssue> {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/repos/${repoFullName}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'matelot' },
    body: JSON.stringify({ title: draft.title, body: draft.body, labels: draft.labels ?? ['security'] }),
  });
  if (!res.ok) throw new Error(`GitHub issue creation failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { number: number; html_url: string; node_id: string };
  return { provider: 'github', key: `${repoFullName}#${data.number}`, url: data.html_url, nodeId: data.node_id };
}

/**
 * Add an issue to a GitHub Projects (v2) board given its URL (https://github.com/orgs/ORG/projects/N or /users/U/projects/N).
 * Needs the App's organization permission "Projects: read & write" (or the `project` scope on a token).
 */
export async function addToGithubProject(apiUrl: string, token: string, boardUrl: string, issueNodeId: string): Promise<string> {
  const m = boardUrl.match(/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)/);
  if (!m) throw new Error(`Not a GitHub Projects URL: ${boardUrl} (expected https://github.com/orgs/<org>/projects/<n>)`);
  const [, kind, owner, number] = m;
  const gql = async (query: string, variables: Record<string, unknown>) => {
    const res = await fetch(`${apiUrl.replace(/\/api\/v3$/, '').replace(/\/$/, '').replace('https://api.github.com', 'https://api.github.com')}/graphql`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'matelot' }, body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) throw new Error(`GitHub Projects: ${body.errors?.map((e) => e.message).join('; ') ?? res.status}`);
    return body.data;
  };
  const lookup = kind === 'orgs' ? await gql('query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){id title}}}', { o: owner, n: Number(number) }) : await gql('query($o:String!,$n:Int!){user(login:$o){projectV2(number:$n){id title}}}', { o: owner, n: Number(number) });
  const project = (kind === 'orgs' ? lookup.organization?.projectV2 : lookup.user?.projectV2) as { id: string; title: string } | undefined;
  if (!project) throw new Error(`GitHub project ${owner}/projects/${number} not found or the connection lacks "Projects: read & write"`);
  await gql('mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}', { p: project.id, c: issueNodeId });
  return project.title;
}

/** Jira Cloud: base URL like https://acme.atlassian.net, basic auth email:apiToken, issue type "Task" by default. */
/** Markdown subset used by the remediation draft → Atlassian Document Format (bold labels, links, paragraphs). */
export function markdownToAdf(md: string): { type: 'doc'; version: 1; content: unknown[] } {
  const inline = (text: string): unknown[] => {
    const out: unknown[] = [];
    const re = /\*\*(.+?)\*\*|(https?:\/\/[^\s)]+)/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
      if (m[1]) out.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
      else out.push({ type: 'text', text: m[2], marks: [{ type: 'link', attrs: { href: m[2] } }] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
    return out.length ? out : [{ type: 'text', text: ' ' }];
  };
  const content: unknown[] = [];
  for (const block of md.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
    const lines = block.split('\n');
    if (lines.every((l) => /^[-*] /.test(l))) content.push({ type: 'bulletList', content: lines.map((l) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inline(l.replace(/^[-*] /, '')) }] })) });
    else if (/^#{1,3} /.test(block)) content.push({ type: 'heading', attrs: { level: Math.min(3, block.indexOf(' ')) }, content: inline(block.replace(/^#+ /, '')) });
    else content.push({ type: 'paragraph', content: lines.flatMap((l, i) => (i ? [{ type: 'hardBreak' }, ...inline(l)] : inline(l))) });
  }
  return { type: 'doc', version: 1, content };
}

const JIRA_PRIORITY: Record<string, string> = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };

export async function createJiraIssue(baseUrl: string, email: string, apiToken: string, projectKey: string, draft: IssueDraft, issueType = 'Task'): Promise<CreatedIssue> {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const base = baseUrl.replace(/\/$/, '');
  const fields: Record<string, unknown> = { project: { key: projectKey }, summary: draft.title, description: markdownToAdf(draft.body), issuetype: { name: issueType }, labels: (draft.labels ?? ['security']).map((l) => l.replace(/\s+/g, '-')) };
  // Native fields when the project allows them: priority from severity, duedate = SLA date. Retried without them on a field error.
  const extras: Record<string, unknown> = {};
  if (draft.severity && JIRA_PRIORITY[draft.severity]) extras.priority = { name: JIRA_PRIORITY[draft.severity] };
  if (draft.dueAt) extras.duedate = draft.dueAt.toISOString().slice(0, 10);
  const post = (f: Record<string, unknown>) => fetch(`${base}/rest/api/3/issue`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: f }) });
  let res = await post({ ...fields, ...extras });
  if (!res.ok && Object.keys(extras).length) {
    const text = await res.text();
    if (res.status === 400 && /priority|duedate/i.test(text)) res = await post(fields); // the screen does not have those fields
    else throw new Error(`Jira issue creation failed: ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`Jira issue creation failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { key: string };
  return { provider: 'jira', key: data.key, url: `${base}/browse/${data.key}` };
}

/** Move a Jira issue to a status of the "done" category (close) or "new"/"indeterminate" (reopen), and comment. Best effort. */
export async function transitionJiraIssue(baseUrl: string, email: string, apiToken: string, key: string, target: 'close' | 'reopen', comment: string): Promise<string | null> {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const base = baseUrl.replace(/\/$/, '');
  const h = { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const tr = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { headers: h });
  if (!tr.ok) throw new Error(`Jira transitions for ${key}: ${tr.status}`);
  const { transitions } = (await tr.json()) as { transitions: { id: string; name: string; to: { name: string; statusCategory: { key: string } } }[] };
  const wanted = target === 'close' ? ['done'] : ['new', 'indeterminate'];
  const t = transitions.find((x) => wanted.includes(x.to.statusCategory.key)) ?? null;
  if (t) {
    const r = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', headers: h, body: JSON.stringify({ transition: { id: t.id } }) });
    if (!r.ok) throw new Error(`Jira transition ${t.name} on ${key}: ${r.status} ${(await r.text()).slice(0, 120)}`);
  }
  await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', headers: h, body: JSON.stringify({ body: markdownToAdf(comment) }) }).catch(() => undefined);
  return t?.to.name ?? null;
}

/** Close / reopen a GitHub issue with a comment. */
export async function setGithubIssueState(apiUrl: string, token: string, repoFullName: string, number: number, state: 'closed' | 'open', comment: string): Promise<void> {
  const base = apiUrl.replace(/\/$/, '');
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'matelot' };
  await fetch(`${base}/repos/${repoFullName}/issues/${number}/comments`, { method: 'POST', headers: h, body: JSON.stringify({ body: comment }) }).catch(() => undefined);
  const r = await fetch(`${base}/repos/${repoFullName}/issues/${number}`, { method: 'PATCH', headers: h, body: JSON.stringify({ state, ...(state === 'closed' ? { state_reason: 'completed' } : {}) }) });
  if (!r.ok) throw new Error(`GitHub issue ${repoFullName}#${number} → ${state}: ${r.status} ${(await r.text()).slice(0, 120)}`);
}

/** Close / reopen a GitLab issue with a note. */
export async function setGitlabIssueState(baseUrl: string, token: string, projectId: string, iid: number, state: 'close' | 'reopen', comment: string): Promise<void> {
  const base = `${baseUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(projectId)}/issues/${iid}`;
  await fetch(`${base}/notes`, { method: 'POST', headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' }, body: JSON.stringify({ body: comment }) }).catch(() => undefined);
  const r = await fetch(base, { method: 'PUT', headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' }, body: JSON.stringify({ state_event: state }) });
  if (!r.ok) throw new Error(`GitLab issue !${iid} → ${state}: ${r.status}`);
}

export async function probeJira(baseUrl: string, email: string, apiToken: string): Promise<string> {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/api/3/myself`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jira answered ${res.status}: check the site URL, e-mail and API token`);
  const me = (await res.json()) as { displayName?: string; emailAddress?: string };
  return me.displayName ?? me.emailAddress ?? 'Jira';
}

/** GitLab issue in the project (id or path) the service repository belongs to. Works for gitlab.com and self-managed. */
export async function createGitlabIssue(baseUrl: string, token: string, projectId: string, draft: IssueDraft): Promise<CreatedIssue> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(projectId)}/issues`, {
    method: 'POST', headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
    body: JSON.stringify({ title: draft.title, description: draft.body, labels: (draft.labels ?? []).join(',') }),
  });
  if (!res.ok) throw new Error(`GitLab responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const issue = (await res.json()) as { iid: number; web_url: string };
  return { provider: 'gitlab', key: `#${issue.iid}`, url: issue.web_url };
}

/** Bitbucket Cloud issue (the repository must have the issue tracker enabled; otherwise use Jira). */
export async function createBitbucketIssue(auth: { username: string; password: string }, repoFullName: string, draft: IssueDraft): Promise<CreatedIssue> {
  const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoFullName}/issues`, {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: draft.title, content: { raw: draft.body, markup: 'markdown' }, kind: 'bug', priority: 'major' }),
  });
  if (!res.ok) throw new Error(`Bitbucket responded ${res.status}: ${(await res.text()).slice(0, 300)} (is the issue tracker enabled on ${repoFullName}?)`);
  const issue = (await res.json()) as { id: number; links: { html: { href: string } } };
  return { provider: 'bitbucket', key: `#${issue.id}`, url: issue.links.html.href };
}

export type TrackerState = { state: 'open' | 'closed'; status: string | null };

export async function readJiraIssueState(baseUrl: string, email: string, apiToken: string, key: string): Promise<TrackerState> {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Jira ${key}: ${r.status}`);
  const d = (await r.json()) as { fields: { status: { name: string; statusCategory: { key: string } } } };
  return { state: d.fields.status.statusCategory.key === 'done' ? 'closed' : 'open', status: d.fields.status.name };
}
export async function readGithubIssueState(apiUrl: string, token: string, repoFullName: string, number: number): Promise<TrackerState> {
  const r = await fetch(`${apiUrl.replace(/\/$/, '')}/repos/${repoFullName}/issues/${number}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'matelot' } });
  if (!r.ok) throw new Error(`GitHub ${repoFullName}#${number}: ${r.status}`);
  const d = (await r.json()) as { state: 'open' | 'closed'; state_reason?: string | null };
  return { state: d.state, status: d.state_reason ?? d.state };
}
export async function readGitlabIssueState(baseUrl: string, token: string, projectId: string, iid: number): Promise<TrackerState> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(projectId)}/issues/${iid}`, { headers: { 'PRIVATE-TOKEN': token } });
  if (!r.ok) throw new Error(`GitLab !${iid}: ${r.status}`);
  const d = (await r.json()) as { state: 'opened' | 'closed' };
  return { state: d.state === 'closed' ? 'closed' : 'open', status: d.state };
}
