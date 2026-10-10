import { signV4 } from './aws-sigv4';

type AwsCreds = { accessKeyId: string; secretAccessKey: string; region: string; sessionToken?: string };

async function call<T>(creds: AwsCreds, target: string, body: unknown): Promise<T> {
  const url = `https://api.ecr.${creds.region}.amazonaws.com/`;
  const payload = JSON.stringify(body);
  const headers = signV4({ method: 'POST', url, service: 'ecr', region: creds.region, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AmazonEC2ContainerRegistry_V20150921.${target}` }, body: payload });
  const response = await fetch(url, { method: 'POST', headers, body: payload });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: string; __type?: string };
      message = `${parsed.__type?.split('#').pop() ?? response.status}: ${parsed.message ?? ''}`;
    } catch {
      /* keep raw */
    }
    throw new Error(`ECR ${target} failed — ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface EcrRepository {
  repositoryName: string;
  repositoryUri: string;
  createdAt?: number;
  imageTagMutability?: 'MUTABLE' | 'IMMUTABLE';
  scanOnPush?: boolean;
}

/** Repositories of the account/region (paged). */
export async function ecrListRepositories(creds: AwsCreds): Promise<EcrRepository[]> {
  const out: EcrRepository[] = [];
  let nextToken: string | undefined;
  do {
    const page = await call<{ repositories: { repositoryName: string; repositoryUri: string; createdAt?: number; imageTagMutability?: 'MUTABLE' | 'IMMUTABLE'; imageScanningConfiguration?: { scanOnPush?: boolean } }[]; nextToken?: string }>(creds, 'DescribeRepositories', { maxResults: 1000, ...(nextToken ? { nextToken } : {}) });
    out.push(...page.repositories.map((r) => ({ repositoryName: r.repositoryName, repositoryUri: r.repositoryUri, createdAt: r.createdAt, imageTagMutability: r.imageTagMutability, scanOnPush: r.imageScanningConfiguration?.scanOnPush })));
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

/** Creates a repository; idempotent when it already exists. */
export async function ecrCreateRepository(creds: AwsCreds, name: string, options: { scanOnPush?: boolean; immutableTags?: boolean } = {}): Promise<EcrRepository> {
  try {
    const r = await call<{ repository: { repositoryName: string; repositoryUri: string; createdAt?: number; imageTagMutability?: 'MUTABLE' | 'IMMUTABLE' } }>(creds, 'CreateRepository', {
      repositoryName: name,
      imageScanningConfiguration: { scanOnPush: options.scanOnPush ?? true },
      imageTagMutability: options.immutableTags ? 'IMMUTABLE' : 'MUTABLE',
      encryptionConfiguration: { encryptionType: 'AES256' },
    });
    return { repositoryName: r.repository.repositoryName, repositoryUri: r.repository.repositoryUri, createdAt: r.repository.createdAt, imageTagMutability: r.repository.imageTagMutability, scanOnPush: options.scanOnPush ?? true };
  } catch (error) {
    if (error instanceof Error && /RepositoryAlreadyExistsException/.test(error.message)) {
      const existing = (await ecrListRepositories(creds)).find((r) => r.repositoryName === name);
      if (existing) return existing;
    }
    throw error;
  }
}
