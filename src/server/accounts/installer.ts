import 'server-only';

import { eq } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { requirePermission } from '@/server/authorization';

import { installDefaultChart } from './internal';

import type { Account } from '@/db/schema';
import type { CoaChoice } from './default-coa';

/**
 * Authorized entry point for installing a chart into an EXISTING company (a
 * setup screen after creation). Requires account.manage. The raw, unauthorized
 * install lives in ./internal.ts — fence-covered so no route can reach it.
 * Company creation uses the internal form directly, before any capability could
 * exist.
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
