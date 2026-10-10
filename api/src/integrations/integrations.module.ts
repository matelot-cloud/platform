import { forwardRef, Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { ExecutionModule } from '../execution/execution.module';
import { GithubAppClient } from './github/github-app.client';
import { GithubSyncService } from './github/github-sync.service';
import { GithubController } from './github/github.controller';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { SourceSyncService } from './source-sync.service';

@Module({
  imports: [JobsModule, forwardRef(() => ExecutionModule)],
  controllers: [IntegrationsController, GithubController],
  providers: [GithubAppClient, GithubSyncService, SourceSyncService, IntegrationsService],
  exports: [GithubAppClient, GithubSyncService, SourceSyncService],
})
export class IntegrationsModule {}
