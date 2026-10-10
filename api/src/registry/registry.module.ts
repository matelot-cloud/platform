import { forwardRef, Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { InventoryModule } from '../inventory/inventory.module';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';

@Module({ imports: [forwardRef(() => ExecutionModule), forwardRef(() => InventoryModule)], controllers: [RegistryController], providers: [RegistryService], exports: [RegistryService] })
export class RegistryModule {}
