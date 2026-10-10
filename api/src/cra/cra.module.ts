import { forwardRef, Module } from '@nestjs/common';
import { PoliciesModule } from '../policies/policies.module';
import { SbomModule } from '../sbom/sbom.module';
import { CraController } from './cra.controller';
import { EvidenceService } from './evidence.service';
import { ReadinessService } from './readiness.service';

@Module({ imports: [forwardRef(() => SbomModule), forwardRef(() => PoliciesModule)], controllers: [CraController], providers: [EvidenceService, ReadinessService], exports: [EvidenceService, ReadinessService] })
export class CraModule {}
