import 'server-only';

import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless';

import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';

import { getDatabaseUrl } from './env';
import * as schema from './schema';

/* ===========================================================================
 * TWO CLIENTS. THIS IS DELIBERATE. READ BEFORE USING EITHER.
 * See docs/DECISIONS.md ADR-001.
 *
 *   getDb()    Neon HTTP driver.  Reads, reports, single-statement writes.
 *              DOES NOT SUPPORT TRANSACTIONS.
 *
 *   getDbTx()  Neon WebSocket Pool. EVERY financial write path.
 *              Supports interactive transactions.
 *
 * The trap this guards against: the HTTP client exposes a `.transaction()`
 * method that is fully typed and compiles cleanly, then throws
 *
 *     Error: No transactions support in neon-http driver
 *
 * at runtime — after review, after CI, in production. The type system cannot
 * catch it. So:
 *
 *   - LedgerService and every financial write path use getDbTx() ONLY.
 *   - ESLint forbids `drizzle-orm/neon-http` under src/server/ledger/**.
 *   - Never simulate a transaction with sequential statements plus
 *     compensating deletes. A compensating delete is not a rollback: it cannot
 *     undo work another connection already observed, and it does not run at all
 *     if the process dies between statements.
 *
 * Both clients are created lazily and memoized. Lazy initialisation is required
 * so `next build` and `npm run ci` succeed in environments with no database —
 * importing this module must not throw, only using it should.
 * =========================================================================== */

export type Schema = typeof schema;
export type HttpDatabase = NeonHttpDatabase<Schema>;
export type PoolDatabase = NeonDatabase<Schema>;

/**
 * Neon's Pool speaks WebSocket. Node has had a global WebSocket since 22.4, but
 * the driver does not wire it up itself, so we do it explicitly rather than
 * depending on undocumented fallback behaviour.
 */
type WebSocketConstructor = NonNullable<typeof neonConfig.webSocketConstructor>;

function configureWebSocket(): void {
  if (neonConfig.webSocketConstructor !== undefined) return;

  const globalWebSocket: unknown = globalThis.WebSocket;

  if (globalWebSocket === undefined) {
    throw new Error(
      'No WebSocket implementation available for the Neon Pool client. ' +
        'LedgerLite requires Node 22.4 or newer (see .nvmrc and package.json engines).',
    );
  }

  neonConfig.webSocketConstructor = globalWebSocket as WebSocketConstructor;
}

let httpDatabase: HttpDatabase | undefined;
let pool: Pool | undefined;
let poolDatabase: PoolDatabase | undefined;

/**
 * HTTP client — reads, reports, single-statement writes.
 *
 * NOT for financial writes. It cannot open a transaction; see the block above.
 */
export function getDb(): HttpDatabase {
  httpDatabase ??= drizzleHttp(neon(getDatabaseUrl()), { schema });
  return httpDatabase;
}

/**
 * Pool client — the ONLY approved client for financial writes.
 *
 * Use inside an explicit transaction:
 *
 *   await getDbTx().transaction(async (tx) => { ... });
 *
 * Every statement of a posting must run on `tx`, not on the outer client, or it
 * executes outside the transaction and will not roll back.
 */
export function getDbTx(): PoolDatabase {
  if (poolDatabase === undefined) {
    configureWebSocket();
    pool = new Pool({ connectionString: getDatabaseUrl() });
    poolDatabase = drizzlePool(pool, { schema });
  }
  return poolDatabase;
}

/**
 * Close the pool. Required in scripts and test teardown — an open pool keeps the
 * process alive. Not used by request handlers, which share the pool.
 */
export async function closeDbTx(): Promise<void> {
  const current = pool;
  pool = undefined;
  poolDatabase = undefined;
  if (current !== undefined) {
    await current.end();
  }
}

export { schema };
export { describeConnection, getDatabaseUrl } from './env';
