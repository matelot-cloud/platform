/**
 * Applies pending SQL migrations from ./drizzle. Runs as the API pod's init container in
 * Kubernetes and via `pnpm db:migrate` locally. Retries while Postgres is still starting.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';

const MAX_ATTEMPTS = Number(process.env.MIGRATE_MAX_ATTEMPTS ?? 30);
const RETRY_DELAY_MS = Number(process.env.MIGRATE_RETRY_DELAY_MS ?? 2000);

/** Locally, read DATABASE_URL from the nearest .env (apps/api/.env or the repo root). */
function loadDotEnv(): void {
  if (process.env.DATABASE_URL) return;
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '..', '.env'),
  ];
  const found = candidates.find((file) => existsSync(file));
  if (found) process.loadEnvFile(found);
}

async function main(): Promise<void> {
  loadDotEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const migrationsFolder = path.resolve(__dirname, '..', 'drizzle');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder });
      console.log(JSON.stringify({ level: 'info', msg: 'migrations applied', migrationsFolder }));
      await pool.end();
      return;
    } catch (error) {
      await pool.end().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS) throw error;
      console.log(JSON.stringify({ level: 'warn', msg: 'migration attempt failed, retrying', attempt, message }));
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'migrations failed', error: String(error) }));
  process.exit(1);
});
