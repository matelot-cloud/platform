import type { GithubRepository } from '../github/github-app.client';

/** Provider-neutral repository shape produced by token-based inventories. */
export interface RemoteRepository {
  externalId: string;
  fullName: string;
  defaultBranch: string | null;
  visibility: string | null;
  archived: boolean;
  htmlUrl: string | null;
  cloneUrl: string | null;
  sshUrl: string | null;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}

export interface RemoteTag {
  tag: string;
  sha?: string;
  source: 'git_tag' | 'github_release' | 'gitlab_release';
  notes?: string;
  url?: string;
  at?: string;
}

/** GitHub with a personal or fine-grained token. `owner` limits the inventory to one organization/user. */
export const githubToken = {
  /** Tags plus GitHub Releases (release notes and dates win over bare tags). */
  async tagsAndReleases(apiUrl: string, token: string, fullName: string): Promise<RemoteTag[]> {
    const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    const tags = await getJson<{ name: string; commit: { sha: string } }[]>(`${apiUrl}/repos/${fullName}/tags?per_page=100`, headers).catch(() => []);
    const rels = await getJson<{ tag_name: string; body: string | null; html_url: string; published_at: string | null; draft: boolean }[]>(`${apiUrl}/repos/${fullName}/releases?per_page=100`, headers).catch(() => []);
    const out = new Map<string, RemoteTag>();
    for (const t of tags) out.set(t.name, { tag: t.name, sha: t.commit.sha, source: 'git_tag' });
    for (const r of rels) if (!r.draft) out.set(r.tag_name, { ...(out.get(r.tag_name) ?? { tag: r.tag_name }), tag: r.tag_name, source: 'github_release', notes: r.body ?? undefined, url: r.html_url, at: r.published_at ?? undefined });
    return [...out.values()];
  },
  async probe(apiUrl: string, token: string): Promise<string> {
    const me = await getJson<{ login: string }>(`${apiUrl}/user`, { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });
    return me.login;
  },
  async listRepositories(apiUrl: string, token: string, owner?: string): Promise<RemoteRepository[]> {
    const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    const base = owner ? `${apiUrl}/orgs/${encodeURIComponent(owner)}/repos?type=all` : `${apiUrl}/user/repos?affiliation=owner,organization_member,collaborator`;
    const all: RemoteRepository[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await getJson<(GithubRepository & { clone_url?: string; ssh_url?: string })[]>(`${base}&per_page=100&page=${page}`, headers).catch(async (error) => {
        // An owner that is a user, not an organization
        if (owner && page === 1 && String(error).includes('404')) return getJson<(GithubRepository & { clone_url?: string; ssh_url?: string })[]>(`${apiUrl}/users/${encodeURIComponent(owner)}/repos?per_page=100&page=1`, headers);
        throw error;
      });
      all.push(
        ...batch.map((r) => ({
          externalId: String(r.id),
          fullName: r.full_name,
          defaultBranch: r.default_branch ?? null,
          visibility: r.visibility ?? (r.private ? 'private' : 'public'),
          archived: r.archived,
          htmlUrl: r.html_url,
          cloneUrl: r.clone_url ?? `${r.html_url}.git`,
          sshUrl: r.ssh_url ?? null,
        })),
      );
      if (batch.length < 100) break;
    }
    return all;
  },
};

interface GitlabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  visibility: string;
  archived: boolean;
  web_url: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
}

/** GitLab.com or self-managed, with a personal/group/project access token (scope: read_api). */
export const gitlab = {
  async tagsAndReleases(baseUrl: string, token: string, projectId: string): Promise<RemoteTag[]> {
    const headers = { 'PRIVATE-TOKEN': token };
    const tags = await getJson<{ name: string; commit: { id: string } }[]>(`${baseUrl}/api/v4/projects/${encodeURIComponent(projectId)}/repository/tags?per_page=100`, headers).catch(() => []);
    const rels = await getJson<{ tag_name: string; description: string | null; released_at: string | null; _links?: { self?: string } }[]>(`${baseUrl}/api/v4/projects/${encodeURIComponent(projectId)}/releases?per_page=100`, headers).catch(() => []);
    const out = new Map<string, RemoteTag>();
    for (const t of tags) out.set(t.name, { tag: t.name, sha: t.commit.id, source: 'git_tag' });
    for (const r of rels) out.set(r.tag_name, { ...(out.get(r.tag_name) ?? { tag: r.tag_name }), tag: r.tag_name, source: 'gitlab_release', notes: r.description ?? undefined, url: r._links?.self, at: r.released_at ?? undefined });
    return [...out.values()];
  },
  async probe(baseUrl: string, token: string): Promise<string> {
    const me = await getJson<{ username: string }>(`${baseUrl}/api/v4/user`, { 'PRIVATE-TOKEN': token });
    return me.username;
  },
  async listRepositories(baseUrl: string, token: string, group?: string): Promise<RemoteRepository[]> {
    const headers = { 'PRIVATE-TOKEN': token };
    const base = group
      ? `${baseUrl}/api/v4/groups/${encodeURIComponent(group)}/projects?include_subgroups=true&simple=false`
      : `${baseUrl}/api/v4/projects?membership=true&simple=false`;
    const all: RemoteRepository[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await getJson<GitlabProject[]>(`${base}&per_page=100&page=${page}`, headers);
      all.push(
        ...batch.map((p) => ({
          externalId: String(p.id),
          fullName: p.path_with_namespace,
          defaultBranch: p.default_branch,
          visibility: p.visibility,
          archived: p.archived,
          htmlUrl: p.web_url,
          cloneUrl: p.http_url_to_repo,
          sshUrl: p.ssh_url_to_repo,
        })),
      );
      if (batch.length < 100) break;
    }
    return all;
  },
};

/** Bitbucket Cloud (api.bitbucket.org/2.0). Auth: basic (Bitbucket username + app password) or a workspace/repository access token (username x-token-auth). */
export const bitbucket = {
  headers(auth: { username: string; password: string }): Record<string, string> {
    return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
  },
  async probe(auth: { username: string; password: string }, workspace?: string): Promise<string> {
    if (workspace) {
      const ws = await getJson<{ slug: string; name: string }>(`https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(workspace)}`, this.headers(auth));
      return ws.slug;
    }
    const me = await getJson<{ username?: string; nickname?: string; display_name?: string }>('https://api.bitbucket.org/2.0/user', this.headers(auth));
    return me.username ?? me.nickname ?? me.display_name ?? 'bitbucket';
  },
  async listRepositories(auth: { username: string; password: string }, workspace: string): Promise<RemoteRepository[]> {
    const all: RemoteRepository[] = [];
    let url: string | null = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=100&fields=next,values.uuid,values.full_name,values.mainbranch.name,values.is_private,values.links.html.href,values.links.clone`;
    for (let i = 0; url && i < 100; i++) {
      const page: { next?: string; values: BitbucketRepo[] } = await getJson(url, this.headers(auth));
      all.push(...page.values.map((r) => ({
        externalId: r.uuid,
        fullName: r.full_name,
        defaultBranch: r.mainbranch?.name ?? null,
        visibility: r.is_private ? 'private' : 'public',
        archived: false,
        htmlUrl: r.links?.html?.href ?? null,
        cloneUrl: r.links?.clone?.find((c) => c.name === 'https')?.href?.replace(/^https:\/\/[^@]+@/, 'https://') ?? null,
        sshUrl: r.links?.clone?.find((c) => c.name === 'ssh')?.href ?? null,
      })));
      url = page.next ?? null;
    }
    return all;
  },
  async tagsAndReleases(auth: { username: string; password: string }, fullName: string): Promise<RemoteTag[]> {
    const page = await getJson<{ values: { name: string; target?: { hash?: string; date?: string } }[] }>(`https://api.bitbucket.org/2.0/repositories/${fullName}/refs/tags?pagelen=100&sort=-target.date`, this.headers(auth)).catch(() => ({ values: [] }));
    return page.values.map((t) => ({ tag: t.name, sha: t.target?.hash, source: 'git_tag' as const, at: t.target?.date }));
  },
};

interface BitbucketRepo { uuid: string; full_name: string; mainbranch?: { name: string }; is_private: boolean; links?: { html?: { href: string }; clone?: { name: string; href: string }[] } }
