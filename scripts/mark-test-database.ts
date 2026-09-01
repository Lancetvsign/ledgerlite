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
 * Usage:  npm run db:mark-test -- --host <endpoint-id>
 *
 * The host must be named explicitly and must match DATABASE_URL. See the comment
 * in main() for why. NEVER run this against production.
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { describeConnection, getDatabaseUrl } from '../src/db/env';
import { assertNotProductionByConfig, TEST_MARKER_TABLE } from '../src/db/safety';

config({ path: '.env.local', quiet: true });

function parseExpectedHost(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--host');
  if (index === -1) return undefined;
  return argv[index + 1];
}

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();

  // Layers 1 and 2 still apply. Layer 3 is what this command CREATES, so it
  // cannot rely on it — which makes this the one command able to arm the safety
  // system on the wrong database.
  assertNotProductionByConfig({
    connectionString,
    appEnv: process.env['APP_ENV'],
    allowlist: process.env['TEST_DATABASE_ALLOWLIST'],
  });

  // So the operator must name the host they believe they are marking, and it must
  // match. This exists because DATABASE_URL is increasingly injected by tooling
  // (the Vercel/Neon integration writes it for you) rather than chosen
  // deliberately, and an allowlist entry pasted from whatever happened to be in
  // .env.local proves only that the two agree — not that either is correct.
  //
  // Typing the endpoint id forces one deliberate look at WHICH branch this is.
  const actualHost = (() => {
    try {
      return new URL(connectionString).hostname;
    } catch {
      return '';
    }
  })();
  const expectedHost = parseExpectedHost(process.argv.slice(2));

  if (expectedHost === undefined || expectedHost.trim() === '') {
    throw new Error(
      `Refusing to mark a database without explicit confirmation.\n\n` +
        `This command makes a database destroyable. Name the host you intend to mark:\n\n` +
        `  npm run db:mark-test -- --host ${actualHost.split('.')[0] ?? '<endpoint-id>'}\n\n` +
        `Before you do, confirm in the Neon console that this endpoint belongs to your\n` +
        `DEVELOPMENT branch and not to production. Target is:\n\n` +
        `  ${describeConnection(connectionString)}`,
    );
  }

  if (!actualHost.startsWith(expectedHost.trim())) {
    throw new Error(
      `Host mismatch. Refusing to mark.\n\n` +
        `  you named : ${expectedHost.trim()}\n` +
        `  actual    : ${actualHost}\n\n` +
        `DATABASE_URL does not point where you think it does. Resolve that before\n` +
        `marking anything — this is exactly the situation the check exists for.`,
    );
  }

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
