import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationCredentials } from '../credentials';

export interface RemoteInfo {
  defaultBranch: string | null;
  refs: number;
}

/** Builds the environment that lets git authenticate without credentials in argv or on disk (SSH keys excepted). */
export async function gitAuthEnvironment(credentials: IntegrationCredentials): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let cleanup = async () => {};
  if (credentials.type === 'token' || credentials.type === 'basic') {
    const user = credentials.type === 'basic' ? credentials.username : (credentials.username ?? 'x-access-token');
    const secret = credentials.type === 'basic' ? credentials.password : credentials.token;
    const basic = Buffer.from(`${user}:${secret}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  } else if (credentials.type === 'ssh') {
    const dir = await mkdtemp(join(tmpdir(), 'secops-ssh-'));
    const keyFile = join(dir, 'id');
    await writeFile(keyFile, credentials.privateKey.endsWith('\n') ? credentials.privateKey : `${credentials.privateKey}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o UserKnownHostsFile=${join(dir, 'known_hosts')}`;
    cleanup = () => rm(dir, { recursive: true, force: true });
  }
  return { env, cleanup };
}

/** `git ls-remote --symref <url> HEAD`: verifies access and reveals the default branch. */
export async function lsRemote(url: string, credentials: IntegrationCredentials, timeoutMs = 30_000): Promise<RemoteInfo> {
  const { env, cleanup } = await gitAuthEnvironment(credentials);
  try {
    const output = await run('git', ['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], env, timeoutMs);
    const lines = output.split('\n').filter(Boolean);
    const symref = lines.find((l) => l.startsWith('ref: '));
    const match = symref?.match(/^ref: refs\/heads\/(\S+)\tHEAD/);
    return { defaultBranch: match?.[1] ?? null, refs: lines.filter((l) => !l.startsWith('ref: ')).length };
  } finally {
    await cleanup();
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        // git prints host-key warnings before the real reason; report the informative lines only.
        const lines = err.split('\n').map((l) => l.trim()).filter((l) => l && !/^Warning:/i.test(l));
        reject(new Error(sanitize(lines.slice(-2).join(' ') || `git exited with ${code}`)));
      }
    });
  });
}

/** Strip anything that looks like a secret from git's stderr before it reaches logs or the API. */
export function sanitize(message: string): string {
  return message.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@').replace(/Authorization: Basic \S+/gi, 'Authorization: Basic ***');
}

/** Human-readable "owner/name" for a git URL: git@host:group/repo.git or https://host/group/repo.git */
export function repositoryNameFromUrl(url: string): string {
  const trimmed = url.replace(/\.git$/, '').replace(/\/+$/, '');
  // scp-like syntax (git@host:group/repo) has no scheme; ssh:// URLs are parsed like http ones.
  const scp = !/^[a-z]+:\/\//i.test(trimmed) && trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  if (scp) return scp[1];
  try {
    return new URL(trimmed).pathname.replace(/^\/+/, '');
  } catch {
    return trimmed;
  }
}

export function isSshUrl(url: string): boolean {
  return /^(ssh:\/\/|[^@\s]+@[^:\s]+:)/.test(url);
}

/** Tags of a remote with their commit shas (peeled when annotated). */
export async function lsRemoteTags(url: string, credentials: IntegrationCredentials, timeoutMs = 30_000): Promise<{ tag: string; sha: string }[]> {
  const { env, cleanup } = await gitAuthEnvironment(credentials);
  try {
    const output = await run('git', ['ls-remote', '--tags', '--refs', url], env, timeoutMs);
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split('\t');
        return { tag: ref.replace('refs/tags/', ''), sha };
      });
  } finally {
    await cleanup();
  }
}
