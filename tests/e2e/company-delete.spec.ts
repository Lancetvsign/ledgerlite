import { expect, test } from '@playwright/test';

import { STORAGE_STATE } from './constants';

test.use({ storageState: STORAGE_STATE });

/** LL-082: the owner deletes a company by retyping its legal name. */
test.describe('delete a company', () => {
  test('an untouched company is removed after typing its name; the other company survives', async ({ page }) => {
    const keep = `Keep Co ${Date.now()}`;
    const doomed = `Doomed Co ${Date.now()}`;
    await page.goto('/account');
    for (const name of [keep, doomed]) {
      await page.getByPlaceholder('New company legal name').fill(name);
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByTestId('company-list')).toContainText(name);
    }

    const row = page.locator('li', { hasText: doomed });
    await row.locator('summary', { hasText: 'Delete' }).click();
    await row.getByPlaceholder('Type the company name to confirm').fill(doomed);
    await row.getByTestId('delete-company-confirm').click();

    await expect(page.getByTestId('notice')).toContainText('Company deleted');
    await expect(page.getByTestId('company-list')).not.toContainText(doomed);
    await expect(page.getByTestId('company-list')).toContainText(keep);
    // The deleted company was the active one; nothing silently became active instead.
    await expect(page.getByTestId('active-badge')).toHaveCount(0);
  });

  test('a wrong name deletes nothing and says so', async ({ page }) => {
    const name = `Safe Co ${Date.now()}`;
    await page.goto('/account');
    await page.getByPlaceholder('New company legal name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('company-list')).toContainText(name);

    const row = page.locator('li', { hasText: name });
    await row.locator('summary', { hasText: 'Delete' }).click();
    await row.getByPlaceholder('Type the company name to confirm').fill(`${name} nope`);
    await row.getByTestId('delete-company-confirm').click();

    await expect(page.getByTestId('notice')).toContainText('does not match');
    await expect(page.getByTestId('company-list')).toContainText(name);
  });
});
