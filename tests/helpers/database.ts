/**
 * Integration-test database access.
 *
 * ISOLATION STRATEGY: truncate-and-reseed between tests. NOT per-test
 * transaction rollback. This is a deliberate choice with three reasons, all of
 * which matter specifically because this is an accounting system:
 *
 * 1. LedgerService owns its own transactions. Wrapping each test in an outer
 *    transaction would make the code under test run in a NESTED transaction
 *    (a savepoint). A rollback inside the service would then unwind to the
 *    savepoint rather than aborting a real transaction — so the test would
 *    exercise semantics that never occur in production.
 *
 * 2. The balance invariant (LL-030) is enforced by a DEFERRABLE INITIALLY
 *    DEFERRED constraint trigger, which fires at COMMIT. A test that never
 *    commits never fires it. Per-test rollback would leave the single most
 *    important guarantee in the product completely untested while showing green.
 *
 * 3. Concurrency and idempotency tests (LL-032) need genuinely separate
 *    concurrent transactions. They cannot exist inside one wrapping transaction.
 *
 * Truncate is slower. For a ledger, being able to test what actually happens at
 * COMMIT is worth far more than the milliseconds.
 */
import { sql } from 'drizzle-orm';

import { closeDbTx, getDbTx, type PoolDatabase } from '@/db';
import { getDatabaseUrl } from '@/db/env';
import { assertSafeForDestructiveUse, TEST_MARKER_TABLE } from '@/db/safety';

/** Never truncated: Drizzle's ledger of applied migrations, and the safety marker. */
const PRESERVED_TABLES = new Set([TEST_MARKER_TABLE, '__drizzle_migrations']);

let guardChecked = false;

async function markerExists(db: PoolDatabase): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(
    sql`select exists (
          select 1 from information_schema.tables
          where table_schema = 'public' and table_name = ${TEST_MARKER_TABLE}
        ) as exists`,
  );
  return result.rows[0]?.exists === true;
}

/**
 * Returns the pooled client, running the three-layer safety guard exactly once
 * per process. Every integration test must obtain its database from here — never
 * by importing `getDbTx` directly — so the guard cannot be bypassed by accident.
 */
export async function getTestDb(): Promise<PoolDatabase> {
  const db = getDbTx();

  if (!guardChecked) {
    await assertSafeForDestructiveUse(
      {
        connectionString: getDatabaseUrl(),
        appEnv: process.env['APP_ENV'],
        allowlist: process.env['TEST_DATABASE_ALLOWLIST'],
      },
      () => markerExists(db),
    );
    guardChecked = true;
  }

  return db;
}

/**
 * Empty every application table, preserving identity so tests start from a known
 * state. Discovers tables rather than hard-coding them, so a table added in a
 * later ticket cannot silently leak rows between tests.
 */
export async function truncateAll(): Promise<void> {
  const db = await getTestDb();

  const result = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );

  const tables = result.rows
    .map((row) => row.table_name)
    .filter((name) => !PRESERVED_TABLES.has(name));

  if (tables.length === 0) return;

  const quoted = tables.map((name) => `"public"."${name}"`).join(', ');
  // RESTART IDENTITY so sequence-derived values are deterministic across tests.
  // CASCADE because tables reference each other; order must not matter.
  await db.execute(sql.raw(`truncate table ${quoted} restart identity cascade`));
}

export async function closeTestDb(): Promise<void> {
  await closeDbTx();
}
