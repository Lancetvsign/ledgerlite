/**
 * Marks a database as safe to destroy.
 *
 * Creates the `_ledgerlite_test_marker` table, which is layer 3 of the safety
 * guard in src/db/safety.ts. Integration tests and `db:verify` refuse to run
 * against any database that does not carry it.
 *
 * This is deliberately NOT a migration. A migration would install the marker
 * everywhere, including production, which would defeat the entire mechanism.
 * Marking a database is a one-time, deliberate human act.
 *
 * Usage:  APP_ENV=test npm run db:mark-test
 *
 * NEVER run this against production.
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { describeConnection, getDatabaseUrl } from '../src/db/env';
import { assertNotProductionByConfig, TEST_MARKER_TABLE } from '../src/db/safety';

config({ path: '.env.local', quiet: true });

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();

  // Layers 1 and 2 still apply. Only layer 3 is being established here, so the
  // config checks are the protection against marking the wrong database.
  assertNotProductionByConfig({
    connectionString,
    appEnv: process.env['APP_ENV'],
    allowlist: process.env['TEST_DATABASE_ALLOWLIST'],
  });

  const globalWebSocket: unknown = globalThis.WebSocket;
  neonConfig.webSocketConstructor = globalWebSocket as typeof neonConfig.webSocketConstructor;

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  try {
    await db.execute(
      sql.raw(
        `create table if not exists "${TEST_MARKER_TABLE}" (
           marked_at timestamptz not null default now(),
           note text not null
         )`,
      ),
    );
    await db.execute(
      sql.raw(
        `insert into "${TEST_MARKER_TABLE}" (note)
         values ('Marked as a disposable test database. Data here may be truncated or dropped at any time.')`,
      ),
    );

    console.info(`Marked ${describeConnection(connectionString)} as a test database.`);
    console.info('Integration tests and db:verify will now run against it.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('\nFAILED TO MARK TEST DATABASE\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
