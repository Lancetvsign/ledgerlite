import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';

import { AccountError } from './errors';

import type { Account } from '@/db/schema';
import type { CreateAccountInput, UpdateAccountInput } from '@/validation/account';

/**
 * Chart-of-accounts service — LL-020.
 *
 * Every operation is company-scoped and passes through the LL-013 authorization
 * layer first. There is NO hard-delete path (ADR-006): accounts are deactivated,
 * never removed, and the parent FK is ON DELETE RESTRICT to back that up.
 *
 * Cross-company safety is not this layer's burden to remember — the composite
 * FK in migration 0003 makes a cross-company parent impossible at the database.
 * What lives here is what SQL cannot express cheaply: transitive cycle
 * detection, and system-account protection.
 */

async function loadInCompany(
  companyId: string,
  accountId: string,
): Promise<Account | undefined> {
  const rows = await getDbTx()
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, accountId)))
    .limit(1);
  return rows[0];
}

/**
 * Walks parent links to prove that making `proposedParentId` the parent of
 * `accountId` introduces no cycle. The DB CHECK stops A→A; this stops A→B→A and
 * longer. Bounded by a hop limit as a belt-and-braces stop against a
 * pre-existing cycle (which the same walk prevents from ever being created).
 */
async function assertNoCycle(
  companyId: string,
  accountId: string | null,
  proposedParentId: string,
): Promise<void> {
  const visited = new Set<string>();
  let cursor: string | null = proposedParentId;
  while (cursor !== null) {
    if (cursor === accountId || visited.has(cursor)) {
      // Reaching the node under edit, OR revisiting any node, is a cycle. The
      // visited-set is essential: pre-existing loop data would otherwise spin
      // the walk forever rather than reporting the cycle.
      throw new AccountError('PARENT_CYCLE', 'This parent would create a cycle.');
    }
    visited.add(cursor);
    const parent: Account | undefined = await loadInCompany(companyId, cursor);
    if (parent === undefined) {
      throw new AccountError('PARENT_NOT_FOUND', 'Parent account not found in this company.');
    }
    cursor = parent.parentAccountId;
  }
}

export async function createAccount(
  actorUserId: string,
  companyId: string,
  input: CreateAccountInput,
): Promise<Account> {
  await requirePermission(actorUserId, companyId, 'account.manage');

  if (input.parentAccountId !== undefined) {
    // accountId is null: the account does not exist yet, so it cannot be in its
    // own ancestry — the walk only needs to confirm the parent chain resolves.
    await assertNoCycle(companyId, null, input.parentAccountId);
  }

  try {
    return await getDbTx().transaction(async (tx) => {
      const rows = await tx
        .insert(schema.accounts)
        .values({
          companyId,
          name: input.name,
          accountType: input.accountType,
          accountNumber: input.accountNumber,
          accountSubtype: input.accountSubtype,
          parentAccountId: input.parentAccountId,
          description: input.description,
        })
        .returning();
      const account = rows[0];
      if (account === undefined) throw new Error('account insert returned no row');
      // Same tx: no account is created without its audit row, and none is
      // audited without being created.
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId: actorUserId,
        action: 'ACCOUNT_CREATED',
        entityType: 'account',
        entityId: account.id,
        after: account,
      });
      return account;
    });
  } catch (error) {
    throw toDomainError(error);
  }
}

/**
 * Drizzle wraps the Postgres error and carries the constraint name in the CAUSE
 * chain, not the top-level message — so matching `error.message` silently misses
 * it (a lesson this codebase keeps relearning). Walk the chain.
 */
function toDomainError(error: unknown): unknown {
  const text = (() => {
    const seen = new Set<unknown>();
    let cur: unknown = error;
    let acc = '';
    while (cur instanceof Error && !seen.has(cur)) {
      seen.add(cur);
      acc += ' ' + cur.message;
      cur = (cur as { cause?: unknown }).cause;
    }
    return acc;
  })();
  if (/accounts_company_number_unique/.test(text)) {
    return new AccountError('DUPLICATE_ACCOUNT_NUMBER', 'That account number is already in use.');
  }
  return error;
}

export async function updateAccount(
  actorUserId: string,
  companyId: string,
  accountId: string,
  input: UpdateAccountInput,
): Promise<Account> {
  await requirePermission(actorUserId, companyId, 'account.manage');

  const existing = await loadInCompany(companyId, accountId);
  if (existing === undefined) {
    throw new AccountError('ACCOUNT_NOT_FOUND', 'Account not found.');
  }

  // Editing permitted fields never touches account_type, system_account_type,
  // or company — those are not in UpdateAccountInput, so there is nothing to
  // guard here beyond the schema itself.
  try {
    const rows = await getDbTx()
      .update(schema.accounts)
      .set({ ...input, updatedAt: sql`now()` })
      .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, accountId)))
      .returning();
    const account = rows[0];
    if (account === undefined) throw new AccountError('ACCOUNT_NOT_FOUND', 'Account not found.');
    return account;
  } catch (error) {
    throw toDomainError(error);
  }
}

/**
 * Deactivates an account. The ONLY removal-shaped operation — there is no hard
 * delete. A system account cannot be deactivated (it is structurally required),
 * and inactive accounts stay queryable for history (ADR-006).
 */
export async function deactivateAccount(
  actorUserId: string,
  companyId: string,
  accountId: string,
): Promise<Account> {
  await requirePermission(actorUserId, companyId, 'account.manage');

  const existing = await loadInCompany(companyId, accountId);
  if (existing === undefined) {
    throw new AccountError('ACCOUNT_NOT_FOUND', 'Account not found.');
  }
  if (existing.systemAccountType !== null) {
    throw new AccountError(
      'SYSTEM_ACCOUNT_PROTECTED',
      'System accounts cannot be deactivated.',
    );
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .update(schema.accounts)
      .set({ status: 'INACTIVE', updatedAt: sql`now()` })
      .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, accountId)))
      .returning();
    const account = rows[0];
    if (account === undefined) throw new AccountError('ACCOUNT_NOT_FOUND', 'Account not found.');
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'ACCOUNT_DEACTIVATED',
      entityType: 'account',
      entityId: account.id,
      before: existing,
      after: account,
    });
    return account;
  });
}

/** Company-scoped listing. `account.view` capability. Includes inactive by default. */
export async function listAccounts(
  actorUserId: string,
  companyId: string,
): Promise<Account[]> {
  await requirePermission(actorUserId, companyId, 'account.view');
  return await getDbTx()
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.companyId, companyId))
    .orderBy(schema.accounts.accountNumber, schema.accounts.name);
}

export { AccountError } from './errors';
export type { AccountErrorCode } from './errors';
