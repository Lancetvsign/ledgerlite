import { expect, test } from '@playwright/test';

import { MEMBERS_STORAGE } from './constants';

/**
 * Team membership — LL-086 / LL-090. The owner invites an email that has no account,
 * fetches a join link, and the invitee creates their account FROM that link in a
 * second browser context. A superseded link is refused.
 */
test.use({ storageState: MEMBERS_STORAGE });

test('invite → join link creates the account and claims it → change role → remove (LL-090)', async ({ page, browser }) => {
  const company = `Team Co ${Date.now()}`;
  const invitee = `invitee-${Date.now()}@synthetic.test`;

  await page.goto('/account');
  await page.getByPlaceholder('New company legal name').fill(company);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('company-list')).toContainText(company, { timeout: 15_000 });
  await page.getByTestId('members-link').click();
  await expect(page).toHaveURL(/\/members$/);
  await expect(page.getByTestId('member-row')).toHaveCount(1);
  await expect(page.getByTestId('you-badge')).toBeVisible();

  await page.getByTestId('invite-email').fill(invitee.toUpperCase());
  await page.getByTestId('invite-role').selectOption('BOOKKEEPER');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('notice')).toContainText('Invitation recorded');
  const invitationRow = page.getByTestId('invitation-row');
  await expect(invitationRow).toHaveCount(1);
  await expect(invitationRow).toContainText(invitee);

  // Get a link, then a second one: the first must stop working.
  await invitationRow.getByTestId('get-invite-link').click();
  const staleLink = (await invitationRow.getByTestId('invite-link').textContent()) ?? '';
  expect(staleLink).toMatch(/\/join\/[A-Za-z0-9_-]{43}$/);
  await invitationRow.getByTestId('get-invite-link').click();
  await expect(invitationRow.getByTestId('invite-link')).not.toHaveText(staleLink);
  const link = (await invitationRow.getByTestId('invite-link').textContent()) ?? '';

  // The invitee opens the link in a fresh browser, creates the account, and claims.
  // A truly signed-out browser: newContext() would otherwise inherit this spec's storage state.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const theirs = await other.newPage();
    await theirs.goto(staleLink);
    await expect(theirs.getByTestId('notice')).toContainText('not valid or has expired');

    await theirs.goto(link);
    await expect(theirs.getByTestId('join-summary')).toContainText(company);
    await expect(theirs.getByTestId('join-summary')).toContainText('BOOKKEEPER');
    await theirs.getByLabel('Name').fill('Invitee');
    await expect(theirs.getByLabel('Email')).toHaveValue(invitee);
    await theirs.getByLabel('Password').fill('synthetic-password-1');
    await theirs.getByTestId('join-create-account').click();
    await theirs.getByTestId('claim-invitation').click();
    await expect(theirs).toHaveURL(/\/account\?ok=joined$/);
    const row = theirs.locator('li', { hasText: company });
    await expect(row).toBeVisible();
    await expect(row).toContainText('BOOKKEEPER');
  } finally {
    await other.close();
  }

  // Back as the owner: the invitation became a member; change the role, then remove.
  await page.goto('/members');
  await expect(page.getByTestId('invitation-row')).toHaveCount(0);
  const memberRow = page.getByTestId('member-row').filter({ hasText: invitee });
  await expect(memberRow).toHaveCount(1);
  await expect(memberRow.getByTestId('member-role')).toHaveText('BOOKKEEPER');
  await memberRow.getByTestId('member-role-select').selectOption('ACCOUNTANT');
  await memberRow.getByTestId('change-role').click();
  await expect(page.getByTestId('notice')).toContainText('Role changed');
  await expect(page.getByTestId('member-row').filter({ hasText: invitee }).getByTestId('member-role')).toHaveText('ACCOUNTANT');
  await page.getByTestId('member-row').filter({ hasText: invitee }).getByTestId('remove-member').click();
  await expect(page.getByTestId('notice')).toContainText('Member removed');
  await expect(page.getByTestId('member-row').filter({ hasText: invitee })).toHaveCount(0);
});

test('the only owner cannot leave, and may offer OWNER when inviting', async ({ page }) => {
  const company = `Solo Co ${Date.now()}`;
  await page.goto('/account');
  await page.getByPlaceholder('New company legal name').fill(company);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('company-list')).toContainText(company);
  await page.goto('/members');

  await expect(page.getByTestId('invite-role').locator('option[value="OWNER"]')).toHaveCount(1);
  await page.getByTestId('member-row').first().getByTestId('remove-member').click();
  await expect(page.getByTestId('notice')).toContainText('nobody else would be able to administer');
  await expect(page.getByTestId('member-row')).toHaveCount(1);
});
