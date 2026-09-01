import 'server-only';

import { sql } from 'drizzle-orm';

import { getDb } from './index';

export interface DatabaseHealth {
  readonly reachable: boolean;
  readonly serverVersion: string | null;
  readonly currentDatabase: string | null;
}

/**
 * Non-financial connectivity probe.
 *
 * Uses the HTTP client deliberately: this is a single read with no transaction,
 * which is exactly what that client is for. See docs/DECISIONS.md ADR-001.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const rows = await getDb().execute<{
    server_version: string;
    current_database: string;
  }>(sql`select version() as server_version, current_database() as current_database`);

  const row = rows.rows[0];

  return {
    reachable: row !== undefined,
    serverVersion: row?.server_version ?? null,
    currentDatabase: row?.current_database ?? null,
  };
}
