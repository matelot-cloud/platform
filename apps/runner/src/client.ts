import type { CodeFindingInput } from './code-scan';
import type { Credentials, Job, LogChunk, RegisterResponse, RegistryCredentials, RunnerConfig } from './protocol';
import { getTracer } from './telemetry';

export class CellClient {
  constructor(
    private readonly baseUrl: string,
    private token: string | null,
  ) {}

  setToken(token: string) {
    this.token = token;
  }

  private async call<T>(path: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<{ status: number; data: T | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // an outside abort (shutdown) closes the connection: the platform then hands back anything it assigned meanwhile
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        // the active span's traceparent: the cell's side of this call (SBOM ingestion, the gate) joins the pipeline's trace
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), 'User-Agent': 'secops-runner/0.1', ...(getTracer()?.currentTraceparent() ? { traceparent: getTracer()!.currentTraceparent()! } : {}) },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      if (response.status === 204) return { status: 204, data: null };
      const text = await response.text();
      if (!response.ok) throw new Error(`${path} → ${response.status}: ${text.slice(0, 300)}`);
      return { status: response.status, data: text ? (JSON.parse(text) as T) : null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Self-hosted: a registration token from the Runners page. Managed (the cell's own, Helm chart): the managed secret. */
  register(credential: { registrationToken: string } | { managedSecret: string }, name: string, tags: string[], version: string, metadata: Record<string, unknown>) {
    return this.call<RegisterResponse>('/runner/register', { ...credential, name, tags, version, metadata }).then((r) => r.data!);
  }

  heartbeat(metadata?: Record<string, unknown>, tags?: string[]) {
    return this.call<{ ok: boolean; config?: RunnerConfig }>('/runner/heartbeat', { metadata, tags }).then((r) => r.data);
  }

  claim(waitSeconds: number, signal?: AbortSignal) {
    return this.call<Job>('/runner/jobs/claim', { waitSeconds }, (waitSeconds + 10) * 1000, signal).then((r) => r.data);
  }

  start(jobId: string) {
    return this.call<Job>(`/runner/jobs/${jobId}/start`);
  }

  jobHeartbeat(jobId: string) {
    return this.call<{ cancelled: boolean }>(`/runner/jobs/${jobId}/heartbeat`).then((r) => r.data!);
  }

  logs(jobId: string, chunks: LogChunk[]) {
    return this.call(`/runner/jobs/${jobId}/logs`, { chunks });
  }

  credentials(jobId: string) {
    return this.call<Credentials>(`/runner/jobs/${jobId}/credentials`).then((r) => r.data!);
  }

  registryCredentials(jobId: string) {
    return this.call<RegistryCredentials>(`/runner/jobs/${jobId}/registry-credentials`).then((r) => r.data!);
  }

  /** Uploads an SBOM document produced by the job (bodies up to 32 MB). */
  sbom(jobId: string, body: { target: 'source' | 'image'; targetRef: string; version?: string; imageRef?: string; document: unknown }) {
    return this.call<{ id: string; componentCount: number; deduplicated: boolean; releaseId: string | null }>(`/runner/jobs/${jobId}/sbom`, body, 120_000).then((r) => r.data!);
  }

  /** The sca job: correlate now; returns the pipeline SBOM's open vulnerabilities. Waits for the run (up to 10 min). */
  correlate(jobId: string) {
    return this.call<{ result: unknown; sbomId: string | null; components: number | null; findings: Record<'critical' | 'high' | 'medium' | 'low' | 'unknown' | 'packages', number> | null }>(`/runner/jobs/${jobId}/correlate`, {}, 11 * 60_000).then((r) => r.data!);
  }

  codeFindings(jobId: string, body: { kind: 'secret' | 'iac' | 'sast'; ref: string; findings: CodeFindingInput[] }) {
    return this.call<{ opened: number; seen: number; fixed: number }>(`/runner/jobs/${jobId}/code-findings`, body).then((r) => r.data!);
  }

  complete(jobId: string, status: 'succeeded' | 'failed' | 'skipped', result?: Record<string, unknown>, error?: string, exitCode?: number) {
    return this.call(`/runner/jobs/${jobId}/complete`, { status, result, error, exitCode });
  }
}
