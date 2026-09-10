/**
 * listRecentEntries — LL-075 (dashboard activity feed). Against a real DB. Newest first,
 * limited, company-scoped, with the correct per-entry total, gated on report.view.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { listRecentEntries, postJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';

import { truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  salesId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `re-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'R' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'RE Co', timezone: 'America/Chicago' }), 'standard');
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const sales = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, cashId: cash.id, salesId: sales.id };
}

function post(c: Ctx, amount: string, date: string) {
  return postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: date, sourceType: 'JOURNAL_ENTRY',
    lines: [{ accountId: c.cashId, debit: amount }, { accountId: c.salesId, credit: amount }],
  }));
}

beforeEach(async () => {
  await truncateAll();
});

describe('listRecentEntries', () => {
  it('returns entries newest first with the correct total, honouring the limit', async () => {
    const c = await setup();
    await post(c, '100.00', '2026-01-10');
    await post(c, '200.00', '2026-03-15');
    await post(c, '50.00', '2026-02-01');

    const all = await listRecentEntries(c.userId, c.companyId);
    expect(all.map((e) => e.postingDate)).toEqual(['2026-03-15', '2026-02-01', '2026-01-10']);
    expect(all[0]?.total).toBe('200.0000');

    const two = await listRecentEntries(c.userId, c.companyId, 2);
    expect(two).toHaveLength(2);
    expect(two.map((e) => e.postingDate)).toEqual(['2026-03-15', '2026-02-01']);
  });

  it('is company-scoped', async () => {
    const a = await setup();
    await post(a, '100.00', '2026-01-10');
    const b = await setup();
    await post(b, '999.00', '2026-05-05');

    const forA = await listRecentEntries(a.userId, a.companyId);
    expect(forA).toHaveLength(1);
    expect(forA[0]?.total).toBe('100.0000');
  });

  it('denies a non-member (report.view fails closed)', async () => {
    const c = await setup();
    const outsider = await makeUser();
    await expect(listRecentEntries(outsider, c.companyId)).rejects.toThrow();
  });
});
