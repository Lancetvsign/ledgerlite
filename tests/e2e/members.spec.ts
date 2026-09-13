import { expect, test } from '@playwright/test';

import { MEMBERS_STORAGE } from './constants';

/**
 * Team membership — LL-086. The owner invites an email that has no account; that
 * email then signs up in a SECOND browser context and finds the company waiting.
 */
test.use({ storageState: MEMBERS_STORAGE });

const ORIGIN = 'http://127.0.0.1:3200';

test('invite → sign-up claims it → change role → remove', async ({ page, browser }) => {
  const company = `Team Co ${Date.now()}`;
  const invitee = `invitee-${Date.now()}@synthetic.test`;

  await page.goto('/account');
  await page.getByPlaceholder('New company legal name').fill(company);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('company-list')).toContainText(company);
  await page.getByTestId('members-link').click();
  await expect(page).toHaveURL(/\/members$/);
  await expect(page.getByTestId('member-row')).toHaveCount(1);
  await expect(page.getByTestId('you-badge')).toBeVisible();

  await page.getByTestId('invite-email').fill(invitee.toUpperCase());
  await page.getByTestId('invite-role').selectOption('BOOKKEEPER');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('notice')).toContainText('Invitation recorded');
  await expect(page.getByTestId('invitation-row')).toHaveCount(1);
  await expect(page.getByTestId('invitation-row')).toContainText(invitee);

  // The invitee signs up and signs in elsewhere — the membership is already there.
  const other = await browser.newContext();
  try {
    const res = await other.request.post('/api/auth/sign-up/email', {
      data: { email: invitee, password: 'synthetic-password-1', name: 'Invitee' },
      headers: { origin: ORIGIN },
    });
    expect(res.ok()).toBe(true);
    const theirs = await other.newPage();
    await theirs.goto('/sign-in');
    await theirs.getByLabel('Email').fill(invitee);
    await theirs.getByLabel('Password').fill('synthetic-password-1');
    await theirs.getByRole('button', { name: 'Sign in' }).click();
    await expect(theirs).toHaveURL(/\/account/);
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
