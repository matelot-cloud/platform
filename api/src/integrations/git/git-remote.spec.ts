import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitAuthEnvironment, isSshUrl, lsRemote, repositoryNameFromUrl, sanitize } from './git-remote';

describe('git remote helpers', () => {
  it('derives repository names from https and ssh URLs', () => {
    expect(repositoryNameFromUrl('https://gitlab.example.com/payments/payment-api.git')).toBe('payments/payment-api');
    expect(repositoryNameFromUrl('git@github.com:acme/payment-api.git')).toBe('acme/payment-api');
    expect(repositoryNameFromUrl('ssh://git@bitbucket.example.com:7999/proj/repo.git')).toBe('proj/repo');
    expect(isSshUrl('git@github.com:acme/x.git')).toBe(true);
    expect(isSshUrl('https://github.com/acme/x.git')).toBe(false);
  });

  it('never leaks credentials in error output or argv', async () => {
    expect(sanitize('fatal: https://user:tok@host/x failed')).toBe('fatal: https://***@host/x failed');
    const { env, cleanup } = await gitAuthEnvironment({ type: 'token', token: 'secret-token' });
    expect(env.GIT_CONFIG_VALUE_0).toContain('Authorization: Basic');
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('secret-token');
    await cleanup();
  });

  it('detects the default branch of a real repository with ls-remote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-'));
    execFileSync('git', ['init', '-q', '-b', 'develop', dir]);
    writeFileSync(join(dir, 'README.md'), 'hello');
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
    const info = await lsRemote(dir, { type: 'none' });
    expect(info.defaultBranch).toBe('develop');
    expect(info.refs).toBeGreaterThanOrEqual(1);
    await expect(lsRemote(join(dir, 'missing'), { type: 'none' })).rejects.toThrow();
  });
});
