import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { Public } from '../auth/public.decorator';
import { DATABASE, Database } from '../database/database.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** Liveness: the process is up. Kubernetes restarts the pod if this fails. */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Kubernetes stops routing traffic while this fails. */
  @Public()
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async () => {
        const indicator = this.indicators.check('database');
        try {
          await this.db.execute(sql`select 1`);
          return indicator.up();
        } catch (error) {
          return indicator.down({ message: error instanceof Error ? error.message : String(error) });
        }
      },
    ]);
  }
}
