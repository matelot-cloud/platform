import { forwardRef, Module } from '@nestjs/common';
import { VulnerabilitiesModule } from '../vulnerabilities/vulnerabilities.module';
import { SbomController } from './sbom.controller';
import { SbomService } from './sbom.service';

@Module({ imports: [forwardRef(() => VulnerabilitiesModule)], controllers: [SbomController], providers: [SbomService], exports: [SbomService] })
export class SbomModule {}
