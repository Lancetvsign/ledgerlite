/**
 * The authorization the LL-024 UI relies on — proven at the SERVER, since the
 * UI's capability checks are cosmetic. The page hides mutation controls from a
 * READ_ONLY user; these tests prove the service refuses the mutation even when
 * the control is bypassed.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { AccountError, createAccount, deactivateAccount, listAccounts, updateAccount } from '@/server/accounts';
import { installDefaultChart } from '@/server/accounts/internal';
import { AuthorizationDenied } from '@/server/authorization';
import { addMembershipAs, createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createAccountInput, updateAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { truncateAll } from '../helpers/database';

import type { AppUser } from '@/db/schema';

const COMPANY = createCompanyInput.parse({ legalName: 'Alpha LLC', timezone: 'America/Chicago' });

async function makeUser(email: string): Promise<AppUser> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: email.split('@')[0] ?? email },
    returnHeaders: true,
  });
  return await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
}

beforeEach(async () => {
  await truncateAll();
});

describe('READ_ONLY: sees but cannot change (server-enforced)', () => {
  it('may list, but every mutation is refused', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const viewer = await makeUser('viewer@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY, 'standard');
    await addMembershipAs(owner.id, company.id, viewer.id, 'READ_ONLY');

    // Sees the chart.
    expect((await listAccounts(viewer.id, company.id)).length).toBeGreaterThan(0);

    const input = createAccountInput.parse({ name: 'Sneaky', accountType: 'EXPENSE' });
    await expect(createAccount(viewer.id, company.id, input)).rejects.toBeInstanceOf(AuthorizationDenied);

    const anAccount = (await listAccounts(owner.id, company.id))[0];
    await expect(updateAccount(viewer.id, company.id, anAccount!.id, updateAccountInput.parse({ name: 'Renamed' })))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    await expect(deactivateAccount(viewer.id, company.id, anAccount!.id))
      .rejects.toBeInstanceOf(AuthorizationDenied);
  });
});

describe('system account protection', () => {
  it('a system account cannot be deactivated, even by an OWNER', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY, 'system-only');
    const ar = (await listAccounts(owner.id, company.id)).find((a) => a.systemAccountType === 'ACCOUNTS_RECEIVABLE');
    expect(ar).toBeDefined();
    await expect(deactivateAccount(owner.id, company.id, ar!.id)).rejects.toBeInstanceOf(AccountError);
  });

  it('a company installs its own chart; another company gets nothing', async () => {
    const a = await makeUser('a@synthetic.test');
    const b = await makeUser('b@synthetic.test');
    const { company: ca } = await createCompanyWithOwner(a.id, COMPANY, 'standard');
    const { company: cb } = await createCompanyWithOwner(b.id, createCompanyInput.parse({ legalName: 'Beta', timezone: 'America/New_York' }));
    await installDefaultChart(ca.id, 'standard'); // idempotent re-run
    expect((await listAccounts(a.id, ca.id)).length).toBeGreaterThan(0);
    expect(await listAccounts(b.id, cb.id)).toHaveLength(0);
  });
});
