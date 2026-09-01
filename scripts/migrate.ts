/**
 * Migration runner.
 *
 * Applies committed migrations under a PostgreSQL advisory lock so concurrent
 * runners serialise instead of racing. Concurrency here is not hypothetical:
 * Vercel can retry or parallelise builds, and CI can start a job while another
 * is mid-deploy. Two runners applying the same migration at once is how a schema
 * ends up half-applied.
 *
 * Usage:  npm run db:migrate
 *
 * NEVER use `drizzle-kit push`. See docs/DATABASE.md and AGENTS.md section 5.
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';

import { describeConnection, getDatabaseUrl } from '../src/db/env';

config({ path: '.env.local', quiet: true });

/**
 * Advisory lock key. Any constant works provided every runner uses the same one.
 * Advisory locks share one namespace across the database, so this value must not
 * collide with another use; it is recorded in docs/DATABASE.md.
 *
 * Passed as a string because it exceeds Number.MAX_SAFE_INTEGER — node-postgres
 * binds it to int8 correctly.
 */
const MIGRATION_LOCK_ID = '8312004771002119';

const MIGRATIONS_FOLDER = 'drizzle/migrations';

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();

  // Safe to print: credentials stripped.
  console.info(`Applying migrations to ${describeConnection(connectionString)}`);

  const globalWebSocket: unknown = globalThis.WebSocket;
  if (globalWebSocket === undefined) {
    throw new Error('Node 22.4 or newer is required (global WebSocket missing).');
  }
  neonConfig.webSocketConstructor = globalWebSocket as typeof neonConfig.webSocketConstructor;

  const pool = new Pool({ connectionString });

  // The lock is held on a dedicated connection that stays checked out for the
  // whole run. Releasing it early would drop the lock while migrations are still
  // applying, which is the race this exists to prevent.
  const lockConnection = await pool.connect();

  try {
    console.info('Acquiring advisory lock…');
    await lockConnection.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    console.info('Lock acquired.');

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });

    console.info('Migrations applied.');
  } finally {
    try {
      await lockConnection.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      lockConnection.release();
      await pool.end();
    }
  }
}

void main().catch((error: unknown) => {
  // A failed migration must fail the process loudly. Never catch and continue —
  // a deployment that proceeds past a migration error runs new code against an
  // old schema. See AGENTS.md section 5.
  console.error('\nMIGRATION FAILED\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
