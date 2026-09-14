import { expect, test } from '@playwright/test';

import { STORAGE_STATE } from './constants';

test.use({ storageState: STORAGE_STATE });

test.describe('company switcher', () => {
  test('create a company, see it listed and active', async ({ page }) => {
    const name = `Playwright Ventures ${Date.now()}`;
    await page.goto('/account');
    await page.getByPlaceholder('New company legal name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByTestId('company-list')).toContainText(name);
    const row = page.locator('li', { hasText: name });
    await expect(row.getByTestId('active-badge')).toBeVisible();
    await expect(row).toContainText('OWNER');
  });

  test('a forged company cookie yields no company, never another tenant view', async ({
    page,
    context,
  }) => {
    // The worst outcome LL-013 names is silent fallback. A garbage claim must
    // leave the user with their own picker — not an error page, and above all
    // not another tenant's data.
    await page.goto('/account'); // establish an origin first — addCookies needs one
    await context.addCookies([
      {
        name: 'ledgerlite_company',
        value: '00000000-0000-4000-8000-00000000dead',
        url: page.url(),
      },
    ]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
    await expect(page.getByTestId('active-badge')).toHaveCount(0);
  });

  test('switching companies moves the active badge', async ({ page }) => {
    const first = `First Co ${Date.now()}`;
    const second = `Second Co ${Date.now()}`;
    await page.goto('/account');
    for (const name of [first, second]) {
      await page.getByPlaceholder('New company legal name').fill(name);
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByTestId('company-list')).toContainText(name);
    }
    // Creating the second made it active; switch back to the first.
    await page.locator('li', { hasText: first }).getByRole('button', { name: 'Switch' }).click();
    await expect(page.locator('li', { hasText: first }).getByTestId('active-badge')).toBeVisible();
    await expect(page.locator('li', { hasText: second }).getByTestId('active-badge')).toHaveCount(0);
  });
});
