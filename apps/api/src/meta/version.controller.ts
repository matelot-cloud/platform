import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

/** Public, unauthenticated: the cell's version, for `matelot doctor` before login, monitoring and the install checks
 *  (`/meta` carries the vocabulary and needs a token). */
@ApiTags('meta')
@Controller('version')
export class VersionController {
  @Public()
  @Get()
  version() {
    return { name: 'matelot', version: process.env.APP_VERSION ?? '0.1.0', commit: process.env.APP_COMMIT ?? null, builtAt: process.env.APP_BUILT_AT ?? null };
  }
}
