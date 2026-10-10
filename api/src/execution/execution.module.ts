import { VulnerabilitiesModule } from '../vulnerabilities/vulnerabilities.module';
import { forwardRef, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IntegrationsModule } from '../integrations/integrations.module';
import { InventoryModule } from '../inventory/inventory.module';
import { RegistryModule } from '../registry/registry.module';
import { SbomModule } from '../sbom/sbom.module';
import { ExecutionController } from './execution.controller';
import { JobsService } from './jobs.service';
import { AutomationService } from './automation.service';
import { PipelinesService } from './pipelines.service';
import { PoolsService } from './pools.service';
import { RunnerController } from './runner.controller';
import { RunnerAuthGuard } from './runner-auth';

@Module({
  imports: [forwardRef(() => VulnerabilitiesModule), forwardRef(() => IntegrationsModule), forwardRef(() => InventoryModule), SbomModule, forwardRef(() => RegistryModule)],
  controllers: [ExecutionController, RunnerController],
  providers: [PoolsService, PipelinesService, AutomationService, JobsService, { provide: APP_GUARD, useClass: RunnerAuthGuard }],
  exports: [JobsService, PoolsService, PipelinesService, AutomationService],
})
export class ExecutionModule {}
