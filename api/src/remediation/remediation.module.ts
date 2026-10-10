import { forwardRef, Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RemediationController } from './remediation.controller';
import { RemediationService } from './remediation.service';

@Module({ imports: [forwardRef(() => IntegrationsModule)], controllers: [RemediationController], providers: [RemediationService], exports: [RemediationService] })
export class RemediationModule {}
