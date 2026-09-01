/**
 * Database connectivity and migration smoke test.
 *
 * Deliberately non-financial. It proves the plumbing works — connection, schema,
 * both clients, transaction semantics — so that later tickets debug their own
 * logic rather than the foundation underneath it.
 *
 * Requires DATABASE_URL, APP_ENV=test, TEST_DATABASE_ALLOWLIST, and a database
 * marked via `npm run db:mark-test`. See docs/TESTING.md.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getTestDb, truncateAll } from '../helpers/database';

describe('database foundation', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('connects and reports a PostgreSQL server', async () => {
    const db = await getTestDb();
    const result = await db.execute<{ version: string }>(sql`select version() as version`);
    expect(result.rows[0]?.version).toMatch(/PostgreSQL/i);
  });

  it('has applied the committed migrations', async () => {
    const db = await getTestDb();
    const result = await db.execute<{ exists: boolean }>(
      sql`select exists (
            select 1 from information_schema.tables
            where table_schema = 'public' and table_name = '_health'
          ) as exists`,
    );
    expect(result.rows[0]?.exists).toBe(true);
  });

  it('commits a transaction that succeeds', async () => {
    const db = await getTestDb();

    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into "_health" (id) values (1)`);
    });

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from "_health"`,
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('rolls back a transaction that throws, leaving nothing behind', async () => {
    // This is the property the whole ledger depends on. If it does not hold,
    // nothing built in Sprint 3 can be trusted.
    const db = await getTestDb();

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into "_health" (id) values (2)`);
        throw new Error('simulated failure mid-transaction');
      }),
    ).rejects.toThrow('simulated failure');

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from "_health"`,
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('returns NUMERIC as a string, not a number (ADR-004)', async () => {
    const db = await getTestDb();
    const result = await db.execute<{ amount: unknown }>(
      sql`select 10000.0000::numeric(19,4) as amount`,
    );
    expect(typeof result.rows[0]?.amount).toBe('string');
  });

  it('truncates cleanly between tests', async () => {
    const db = await getTestDb();
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from "_health"`,
    );
    expect(rows.rows[0]?.count).toBe('0');
  });
});
