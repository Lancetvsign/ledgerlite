import { expect, test } from '@playwright/test';

import { ACCOUNTS_STORAGE } from './constants';

/**
 * Master template company — LL-083. Uses the dedicated accounts session. The template
 * is a GLOBAL slot and the e2e database persists between runs, so the test releases
 * whatever template this user owns first and always releases its own in `finally`.
 */
test.use({ storageState: ACCOUNTS_STORAGE });

test('a designated master company seeds the chart and settings of the next company', async ({ page }) => {
  await page.goto('/account');
  // Pre-clean: release a leftover template of our own; a foreign one means we cannot run.
  const leftover = page.getByTestId('release-template');
  if (await leftover.count()) {
    await leftover.first().click();
    await expect(page.getByTestId('notice')).toContainText('no longer the master template');
  }
  const foreign = await page.locator('select[name="chart"] option[value="template"]').count();
  test.skip(foreign > 0, 'another user owns the template slot in this database');

  const master = `Master Co ${Date.now()}`;
  const child = `Child Co ${Date.now()}`;
  try {
    await page.getByPlaceholder('New company legal name').fill(master);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('company-list')).toContainText(master);

    const masterRow = page.locator('li', { hasText: master });
    await masterRow.getByTestId('make-template').click();
    await expect(page.getByTestId('notice')).toContainText('now the master template');
    await expect(masterRow.getByTestId('template-badge')).toBeVisible();

    // Add an account only the template has (it is the active company).
    await page.getByRole('link', { name: 'Chart of Accounts' }).click();
    await page.getByRole('button', { name: 'New account' }).click();
    await page.getByPlaceholder('Number (optional)').fill('7777');
    await page.getByPlaceholder('Account name').fill('Template Only 7777');
    await page.getByRole('combobox', { name: 'Account type' }).selectOption('EXPENSE');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('accounts-table')).toContainText('Template Only 7777');

    // The create form now defaults to the master template.
    await page.goto('/account');
    await expect(page.locator('select[name="chart"]')).toHaveValue('template');
    await page.getByPlaceholder('New company legal name').fill(child);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('company-list')).toContainText(child);
    await expect(page.locator('li', { hasText: child }).getByTestId('active-badge')).toBeVisible();

    await page.getByRole('link', { name: 'Chart of Accounts' }).click();
    const table = page.getByTestId('accounts-table');
    await expect(table).toContainText('Template Only 7777');
    await expect(table).toContainText('Accounts Receivable');
    await expect(page.locator('tr', { hasText: 'Accounts Receivable' }).getByTestId('system-badge')).toBeVisible();
  } finally {
    await page.goto('/account');
    const release = page.locator('li', { hasText: master }).getByTestId('release-template');
    if (await release.count()) {
      await release.click();
      // Wait for the release to land. The next spec's create form defaults to the
      // template while one exists; a release still in flight when that page renders
      // makes its create fail with NO_TEMPLATE.
      await expect(page.getByTestId('notice')).toContainText('no longer the master template');
    }
  }
});
