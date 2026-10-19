/** Wire types of the runner ↔ cell protocol (mirrors apps/api/src/execution). */
export interface RegisterResponse {
  runnerId: string;
  runnerToken: string;
  pool: { id: string; slug: string; name: string; tags: string[] };
  config?: RunnerConfig;
}

export interface Job {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  repositoryId: string | null;
  timeoutSeconds: number;
  attempts: number;
  /** W3C traceparent of this job's span in the pipeline's trace: the runner's spans go under it (telemetry.ts). */
  traceParent?: string | null;
}

export type Credentials =
  | { kind: 'none' }
  | { kind: 'https'; url: string; username?: string; secret?: string; defaultBranch: string | null; fullName: string }
  | { kind: 'ssh'; url: string; privateKey: string; defaultBranch: string | null; fullName: string };

export interface LogChunk {
  seq: number;
  stream: 'stdout' | 'stderr' | 'system';
  content: string;
}

export type RegistryCredentials = { kind: 'none' } | { kind: 'registry'; host: string; username: string; secret: string };

export interface RunnerConfig {
  registryHostAliases: Record<string, string>;
  latestVersion: string;
}
