import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { projects, serviceRepositories, services } from '../database/schema';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { PipelinesService } from './pipelines.service';

export type PipelineOnPush = 'default_branch' | 'all' | 'off';

/** Project automation: what the platform does by itself when code moves. */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pipelines: PipelinesService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** A push to a branch of a repository: start the security pipeline for every service that uses it, per project setting. */
  async onPush(repositoryId: string, branch: string, commitSha: string, defaultBranch: string | null): Promise<number> {
    const rows = await this.db
      .select({ serviceId: services.id, projectId: projects.id, settings: projects.settings })
      .from(serviceRepositories)
      .innerJoin(services, eq(serviceRepositories.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .where(and(eq(serviceRepositories.repositoryId, repositoryId), isNull(services.archivedAt)));
    let started = 0;
    for (const row of rows) {
      const automation = (row.settings.automation ?? {}) as { pipelineOnPush?: PipelineOnPush; template?: string };
      const mode = automation.pipelineOnPush ?? 'default_branch';
      if (mode === 'off') continue;
      if (mode === 'default_branch' && defaultBranch && branch !== defaultBranch) continue;
      try {
        const chain = await this.resolver.resolveChain({ serviceId: row.serviceId });
        await this.pipelines.create(null, chain, { template: automation.template ?? 'security', repositoryId, ref: commitSha, commitSha, trigger: 'push' });
        started++;
      } catch (error) {
        this.logger.warn(`pipeline on push failed for service ${row.serviceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return started;
  }
}
