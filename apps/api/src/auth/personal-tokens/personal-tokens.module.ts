import { Global, Module } from '@nestjs/common';
import { PersonalTokensService } from './personal-tokens.service';

/** Global: personal tokens authenticate HTTP (guard), the MCP transport and the built-in registry (`docker login -u token -p spt_…`). */
@Global()
@Module({ providers: [PersonalTokensService], exports: [PersonalTokensService] })
export class PersonalTokensModule {}
