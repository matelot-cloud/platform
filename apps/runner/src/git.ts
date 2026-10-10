import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credentials } from './protocol';

/** Same approach as the cell: credentials go through the environment, never argv. */
export async function gitEnvironment(credentials: Credentials): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let cleanup = async () => {};
  if (credentials.kind === 'https' && credentials.secret) {
    const basic = Buffer.from(`${credentials.username ?? 'x-access-token'}:${credentials.secret}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  } else if (credentials.kind === 'ssh') {
    const dir = await mkdtemp(join(tmpdir(), 'runner-ssh-'));
    const keyFile = join(dir, 'id');
    await writeFile(keyFile, credentials.privateKey.endsWith('\n') ? credentials.privateKey : `${credentials.privateKey}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o UserKnownHostsFile=${join(dir, 'known_hosts')}`;
    cleanup = () => rm(dir, { recursive: true, force: true });
  }
  return { env, cleanup };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command, streaming output to `onLine`, returning the exit code. */
export function run(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (stream: 'stdout' | 'stderr', line: string) => void; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      options.onLine?.('stdout', text);
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      options.onLine?.('stderr', text);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function sanitize(message: string): string {
  return message.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@').replace(/Authorization: Basic \S+/gi, 'Authorization: Basic ***');
}
