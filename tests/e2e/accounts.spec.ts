import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS_STORAGE } from './constants';

/**
 * Chart of accounts UI — LL-024.
 *
 * Uses a DEDICATED signed-in session (the accounts.setup project) so its many
 * company/account writes never race the shared-user auth specs. The final test
 * runs unauthenticated in its own fresh context.
 */

async function freshCompanyWithChart(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Accts Co ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await page.getByPlaceholder('New company legal name').fill(name);
  // The chart select defaults to "standard".
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('company-list')).toContainText(name);
  await page.getByRole('link', { name: 'Chart of Accounts →' }).click();
  await expect(page).toHaveURL(/\/accounts/);
}

test.describe('authenticated', () => {
  test.use({ storageState: ACCOUNTS_STORAGE });

  test('lists the installed chart', async ({ page }) => {
    await freshCompanyWithChart(page);
    await expect(page.getByTestId('account-row').first()).toBeVisible();
    await expect(page.getByTestId('accounts-table')).toContainText('Checking');
    await expect(page.getByTestId('accounts-table')).toContainText('Accounts Receivable');
    // Must NOT show a balance column. (The footnote explaining balances are
    // derived is the point being made, so it is fine.)
    await expect(page.getByTestId('accounts-table').locator('thead')).not.toContainText('Balance');
  });

  test('search filters the list', async ({ page }) => {
    await freshCompanyWithChart(page);
    await page.getByPlaceholder('Search number, name, type…').fill('Checking');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByTestId('accounts-table')).toContainText('Checking');
    await expect(page.getByTestId('accounts-table')).not.toContainText('Retained Earnings');
  });

  test('create, edit, then deactivate an account', async ({ page }) => {
    await freshCompanyWithChart(page);

    await page.getByRole('button', { name: 'New account' }).click();
    await page.getByPlaceholder('Account name').fill('Petty Cash');
    await page.getByRole('combobox').selectOption('ASSET');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('accounts-table')).toContainText('Petty Cash');

    const row = page.getByTestId('account-row').filter({ hasText: 'Petty Cash' });
    await row.getByRole('button', { name: 'Edit' }).click();
    const editForm = page.locator('form', { has: page.getByRole('button', { name: 'Save' }) });
    await editForm.getByRole('textbox').first().fill('Petty Cash Box');
    await editForm.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('accounts-table')).toContainText('Petty Cash Box');

    const row2 = page.getByTestId('account-row').filter({ hasText: 'Petty Cash Box' });
    await row2.getByTestId('deactivate').click();
    await expect(page.getByTestId('account-row').filter({ hasText: 'Petty Cash Box' })).toContainText(
      'INACTIVE',
    );
  });

  test('system accounts show a badge and offer no deactivate', async ({ page }) => {
    await freshCompanyWithChart(page);
    const arRow = page.getByTestId('account-row').filter({ hasText: 'Accounts Receivable' });
    await expect(arRow.getByTestId('system-badge')).toBeVisible();
    await expect(arRow.getByTestId('deactivate')).toHaveCount(0);
  });
});

test.describe('unauthenticated', () => {
  test('access to /accounts redirects to sign-in', async ({ browser }) => {
    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto('/accounts');
    await expect(page).toHaveURL(/\/sign-in/);
    await anon.close();
  });
});
