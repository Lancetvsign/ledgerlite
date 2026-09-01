/**
 * Fails if the target database contains any rows in the public schema.
 *
 * Guards the property that makes Preview deployments safe: a `--schema-only`
 * Neon branch carries the schema and no data. A normal Neon branch is
 * copy-on-write from its parent, so if that flag ever silently stops working,
 * a Preview URL would serve a complete copy of the production ledger.
 *
 * This check exists so that regression fails the workflow instead of shipping.
 *
 * Usage:  npm run db:assert-empty
 *
 * NOTE: written as a script rather than `tsx -e` because tsx transpiles to CJS,
 * where top-level await does not compile. That mistake is what let this check
 * silently not run the first time it was deployed.
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { describeConnection, getDatabaseUrl } from '../src/db/env';

config({ path: '.env.local', quiet: true });

interface TableCount {
  readonly table_name: string;
  readonly row_count: string;
}

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();
  console.info(`Asserting ${describeConnection(connectionString)} is empty`);

  neonConfig.webSocketConstructor = globalThis.WebSocket;
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  try {
    // Counted with count(*), not pg_stat_user_tables. Statistics are populated by
    // ANALYZE and lag behind reality — on a freshly created branch they can read
    // zero while rows are present, which would make this check pass for a
    // database full of production data. An exact count is the only safe basis
    // for a claim like this.
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );

    const names = tables.rows.map((r) => r.table_name);
    if (names.length === 0) {
      console.info('No tables in the public schema. Empty.');
      return;
    }

    const counts: TableCount[] = [];
    for (const name of names) {
      const r = await db.execute<{ row_count: string }>(
        sql.raw(`select count(*)::text as row_count from "public"."${name}"`),
      );
      counts.push({ table_name: name, row_count: r.rows[0]?.row_count ?? '0' });
    }

    const populated = counts.filter((c) => c.row_count !== '0');

    for (const c of counts) {
      console.info(`  ${c.table_name}: ${c.row_count}`);
    }

    if (populated.length > 0) {
      const detail = populated.map((c) => `${c.table_name}=${c.row_count}`).join(', ');
      console.error(
        `::error title=Preview database is not empty::${detail}. ` +
          'A schema-only branch must contain no rows. Refusing to expose it.',
      );
      process.exit(1);
    }

    console.info('Empty. Safe to expose.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  // Failing closed: an unreadable answer is not "empty".
  console.error('\nEMPTINESS ASSERTION FAILED\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
