import { forwardRef, Module } from '@nestjs/common';
import { PoliciesModule } from '../policies/policies.module';
import { ExecutionModule } from '../execution/execution.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RegistryModule } from '../registry/registry.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [forwardRef(() => PoliciesModule), forwardRef(() => IntegrationsModule), forwardRef(() => ExecutionModule), forwardRef(() => RegistryModule)],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
