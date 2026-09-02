/**
 * Drops and recreates the schema on a preview database, so migrations can apply
 * from scratch.
 *
 * WHY THIS IS NEEDED. A Neon `--schema-only` branch copies the parent's schema
 * and none of its rows — which is exactly what makes it safe to expose. But
 * "none of its rows" includes `drizzle.__drizzle_migrations`, so Drizzle sees an
 * unmigrated database whose tables already exist and fails on
 * `CREATE TABLE "_health"`.
 *
 * Two ways out: fabricate migration records to match the parent, or drop the
 * schema and let migrations rebuild it. The second is chosen because it produces
 * a database whose schema provably came from the committed migrations, rather
 * than one asserted to match them. It also exercises the migrations on every PR
 * at no extra cost.
 *
 * SAFETY. This is destructive, so it re-verifies emptiness itself rather than
 * trusting the caller to have run the assertion first. A future edit that
 * reorders the workflow steps cannot turn this into a data-loss bug.
 *
 * Usage:  npm run db:reset-preview
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { describeConnection, getDirectDatabaseUrl } from '../src/db/env';

config({ path: '.env.local', quiet: true });

async function main(): Promise<void> {
  // Direct endpoint: DDL plus the advisory lock that follows in db:migrate.
  const connectionString = getDirectDatabaseUrl();
  console.info(`Resetting schema on ${describeConnection(connectionString)}`);

  neonConfig.webSocketConstructor = globalThis.WebSocket;
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  try {
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );

    // Re-verify emptiness HERE, immediately before dropping. The workflow runs
    // db:assert-empty first, but this script must not depend on that ordering.
    for (const { table_name: name } of tables.rows) {
      const r = await db.execute<{ row_count: string }>(
        sql.raw(`select count(*)::text as row_count from "public"."${name}"`),
      );
      const count = r.rows[0]?.row_count ?? '0';
      if (count !== '0') {
        throw new Error(
          `Refusing to drop schema: "${name}" contains ${count} row(s).\n\n` +
            'This script only ever runs against a schema-only preview branch, which\n' +
            'must be empty. Rows here mean the branch carries real data and dropping\n' +
            'it would destroy something that matters.',
        );
      }
    }

    console.info(`${String(tables.rows.length)} empty table(s) verified. Dropping.`);

    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`drop schema public cascade`);
    await db.execute(sql`create schema public`);

    console.info('Schema reset. Migrations will rebuild it from committed files.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('\nPREVIEW SCHEMA RESET FAILED\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
