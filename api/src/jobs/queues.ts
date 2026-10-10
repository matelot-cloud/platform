/** Queue names shared by the API (producer) and the worker (consumer). */
export const QUEUES = {
  githubSync: 'github-sync',
  githubWebhooks: 'github-webhooks',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface GithubSyncJob {
  integrationId: string;
}

export interface GithubWebhookJob {
  deliveryId: string;
}
