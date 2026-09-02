/**
 * Database foundation verification (LL-002 acceptance).
 *
 * Proves, against a REAL database, the things a type checker cannot:
 *
 *   1. The target is not production.
 *   2. Migrations apply to a clean database.
 *   3. Re-running migrations is a no-op, not an error and not a duplicate.
 *   4. The advisory lock serialises concurrent runners.
 *   5. Both clients connect, and the HTTP client cannot open a transaction.
 *
 * Usage:  npm run db:verify
 *
 * Requires DATABASE_URL pointing at YOUR OWN Neon development branch. This
 * script CREATES AND DROPS the _health table and will refuse to run against
 * anything that looks like production.
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { describeConnection, getDirectDatabaseUrl } from '../src/db/env';
import { assertSafeForDestructiveUse, TEST_MARKER_TABLE } from '../src/db/safety';

config({ path: '.env.local', quiet: true });

let failures = 0;

function check(label: string, passed: boolean, detail = ''): void {
  if (!passed) failures += 1;
  console.info(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function run(command: string, args: readonly string[]): Promise<number> {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'ignore', shell: false });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const connectionString = getDirectDatabaseUrl();
  console.info(`Verifying against ${describeConnection(connectionString)}\n`);

  // The expected number of applied migrations is however many are committed —
  // derived, not hard-coded. The literal 1 this replaces went stale the moment
  // migration 0001 landed.
  const { readdirSync } = await import('node:fs');
  const expectedMigrations = readdirSync('drizzle/migrations').filter((f) =>
    f.endsWith('.sql'),
  ).length;

  const globalWebSocket: unknown = globalThis.WebSocket;
  neonConfig.webSocketConstructor = globalWebSocket as typeof neonConfig.webSocketConstructor;

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  try {
    // The same three-layer guard the integration tests use. See src/db/safety.ts.
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
    check('target is a marked, allowlisted test database', true);

    // --- clean slate ------------------------------------------------------
    // Discovered, not listed. A hard-coded table list rots the moment a
    // migration adds a table: LL-010's auth tables survived the old
    // drop-_health-only version, and "migrations apply to a clean database"
    // failed on tables that already existed. The safety marker is the one
    // survivor — removing it would trip the guard on the next run.
    const existing = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    for (const { table_name: name } of existing.rows) {
      if (name === TEST_MARKER_TABLE) continue;
      await db.execute(sql.raw(`drop table if exists "public"."${name}" cascade`));
    }
    await db.execute(sql`drop schema if exists "drizzle" cascade`);
    // Enum types survive table drops. Leaving them behind fails the re-apply on
    // CREATE TYPE ... already exists — caught by CI when migration 0002
    // introduced the first enums, invisible locally because db:verify had not
    // been re-run since. Discovered, like the tables, never listed.
    const enums = await db.execute<{ typname: string }>(
      sql`select t.typname from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public' and t.typtype = 'e'`,
    );
    for (const { typname } of enums.rows) {
      await db.execute(sql.raw(`drop type if exists "public"."${typname}" cascade`));
    }

    // --- 2. migrations apply to a clean database --------------------------
    const first = await run('npx', ['tsx', 'scripts/migrate.ts']);
    check('migrations apply to a clean database', first === 0, `exit ${first}`);

    const tableExists = await db.execute<{ exists: boolean }>(
      sql`select exists (select 1 from information_schema.tables where table_name = '_health') as exists`,
    );
    check('_health table created', tableExists.rows[0]?.exists === true);

    // --- 3. re-running is a no-op ----------------------------------------
    const second = await run('npx', ['tsx', 'scripts/migrate.ts']);
    check('re-running migrations succeeds', second === 0, `exit ${second}`);

    const applied = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from "drizzle"."__drizzle_migrations"`,
    );
    check(
      're-run did not duplicate migration records',
      applied.rows[0]?.count === String(expectedMigrations),
      `${applied.rows[0]?.count ?? '?'} row(s), expected ${String(expectedMigrations)}`,
    );

    // --- 4. advisory lock serialises concurrent runners -------------------
    // Both runners start together. Without the lock they race on the same
    // migration table; with it, one waits for the other. Both must exit 0.
    const [a, b] = await Promise.all([
      run('npx', ['tsx', 'scripts/migrate.ts']),
      run('npx', ['tsx', 'scripts/migrate.ts']),
    ]);
    check('two concurrent runners both succeed', a === 0 && b === 0, `exits ${a}, ${b}`);

    const afterConcurrent = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from "drizzle"."__drizzle_migrations"`,
    );
    check(
      'concurrent runners did not duplicate migration records',
      afterConcurrent.rows[0]?.count === String(expectedMigrations),
      `${afterConcurrent.rows[0]?.count ?? '?'} row(s), expected ${String(expectedMigrations)}`,
    );

    // --- 5. the HTTP client genuinely cannot transact ---------------------
    const { neon } = await import('@neondatabase/serverless');
    const { drizzle: drizzleHttp } = await import('drizzle-orm/neon-http');
    const httpDb = drizzleHttp(neon(connectionString));

    let httpThrew = '';
    try {
      await httpDb.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
      });
    } catch (error) {
      httpThrew = error instanceof Error ? error.message : String(error);
    }
    check(
      'HTTP client rejects interactive transactions (ADR-001)',
      /no transactions support/i.test(httpThrew),
      httpThrew || 'it did NOT throw — ADR-001 assumption broken',
    );

    // --- Pool client can transact ----------------------------------------
    let poolOk = false;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      poolOk = true;
    });
    check('Pool client supports interactive transactions (ADR-001)', poolOk);
  } finally {
    await pool.end();
  }

  console.info(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error('\nVERIFICATION FAILED\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
