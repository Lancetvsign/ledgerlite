import 'server-only';

import { getDbTx, schema } from '@/db';

import { chartFor, type CoaChoice } from './default-coa';

import type { PoolDatabase } from '@/db';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * UNAUTHORIZED-BY-DEFAULT default-chart install. In this fence-covered module
 * (src/app/** cannot import *_/internal) after the Gate 2A review flagged that
 * it lived in installer.ts, one import away from a route with no lint to stop
 * an attacker-supplied companyId. Callers: company creation (into the just-made
 * company, in-tx, before any capability exists) and the authorized
 * installDefaultChartFor. Idempotent via ON CONFLICT on (company_id,
 * account_number).
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
