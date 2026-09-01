/**
 * Deterministic synthetic seed.
 *
 * Used for Preview databases and local development. NEVER for production, and
 * never containing real customer or financial data — a Preview environment is
 * shared with anyone who can open the deployment URL.
 *
 * Runs the same three-layer safety guard as the tests: it will not touch a
 * database that has not been explicitly marked disposable.
 *
 * Usage:  npm run db:seed
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { describeConnection, getDatabaseUrl } from '../src/db/env';
import { assertSafeForDestructiveUse, TEST_MARKER_TABLE } from '../src/db/safety';

config({ path: '.env.local', quiet: true });

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();
  console.info(`Seeding ${describeConnection(connectionString)}`);

  neonConfig.webSocketConstructor = globalThis.WebSocket;
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  try {
    await assertSafeForDestructiveUse(
      {
        connectionString,
        appEnv: process.env['APP_ENV'],
        allowlist: process.env['TEST_DATABASE_ALLOWLIST'],
      },
      async () => {
        const r = await db.execute<{ exists: boolean }>(
          sql`select exists (
                select 1 from information_schema.tables
                where table_schema = 'public' and table_name = ${TEST_MARKER_TABLE}
              ) as exists`,
        );
        return r.rows[0]?.exists === true;
      },
    );

    // Idempotent: seeding twice produces the same state, so a re-run on an
    // existing Preview branch is safe.
    await db.execute(sql`
      insert into "_health" (id, last_checked_at)
      values (1, now())
      on conflict (id) do update set last_checked_at = now()
    `);

    console.info('Seeded.');
    console.info('No accounting data exists yet — companies, accounts and journals');
    console.info('arrive in LL-011, LL-020 and LL-030. Extend this script there.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('\nSEED FAILED\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
