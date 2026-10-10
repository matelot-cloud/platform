import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { DigestService } from './digest.service';
import { ConfigApplyService } from './config-apply.service';
import { PoliciesModule } from '../policies/policies.module';
import { RemediationModule } from '../remediation/remediation.module';
import { forwardRef } from '@nestjs/common';

@Global()
@Module({ imports: [forwardRef(() => RemediationModule), forwardRef(() => PoliciesModule)], controllers: [NotificationsController], providers: [NotificationsService, DigestService, ConfigApplyService], exports: [NotificationsService, DigestService] })
export class NotificationsModule {}
