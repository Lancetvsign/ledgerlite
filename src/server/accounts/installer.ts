import 'server-only';

import { eq } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { requirePermission } from '@/server/authorization';

import { chartFor, type CoaChoice } from './default-coa';

import type { Account } from '@/db/schema';
import type { PoolDatabase } from '@/db';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Installs a default chart of accounts — LL-023.
 *
 * IDEMPOTENT BY CONSTRUCTION. It upserts on (company_id, account_number) with
 * ON CONFLICT DO NOTHING, so running it twice — even CONCURRENTLY — produces
 * exactly one row per account number. There is no check-then-insert (which
 * races); the database's unique constraint is the arbiter. No journal entries,
 * no balances — account structure only.
 *
 * `tx` is optional so company creation can install the chart inside the same
 * transaction that creates the company and its owner membership.
 */
export async function installDefaultChart(
  companyId: string,
  choice: CoaChoice,
  tx?: Tx,
): Promise<number> {
  const executor = tx ?? getDbTx();
  const chart = chartFor(choice);

  const result = await executor
    .insert(schema.accounts)
    .values(
      chart.map((a) => ({
        companyId,
        accountNumber: a.accountNumber,
        name: a.name,
        accountType: a.accountType,
        accountSubtype: a.accountSubtype,
        systemAccountType: a.systemAccountType ?? null,
      })),
    )
    // The idempotency mechanism: a re-run collides on (company_id,
    // account_number) and inserts nothing, rather than duplicating.
    .onConflictDoNothing({
      target: [schema.accounts.companyId, schema.accounts.accountNumber],
    })
    .returning({ id: schema.accounts.id });

  return result.length; // rows actually inserted this run (0 on a repeat)
}

/**
 * Authorized entry point for installing into an EXISTING company (a setup screen
 * after creation). Requires account.manage. Company creation uses the tx form
 * above directly, before any capability could exist.
 */
export async function installDefaultChartFor(
  actorUserId: string,
  companyId: string,
  choice: CoaChoice,
): Promise<Account[]> {
  await requirePermission(actorUserId, companyId, 'account.manage');
  await installDefaultChart(companyId, choice);
  return await getDbTx()
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.companyId, companyId))
    .orderBy(schema.accounts.accountNumber);
}
