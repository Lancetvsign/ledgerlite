import { expect, test } from '@playwright/test';

test.describe('application shell', () => {
  test('serves the landing page', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'LedgerLite' })).toBeVisible();
    await expect(page.getByText('Development Environment')).toBeVisible();
  });

  test('reports no console errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'LedgerLite' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('exposes no accounting functionality yet', async ({ page }) => {
    // Sprint 0 guardrail: the shell must stay a shell. If this starts failing,
    // a feature has been built ahead of the ledger it depends on.
    await page.goto('/');
    const body = (await page.textContent('body')) ?? '';
    for (const term of ['Invoice', 'Journal', 'Chart of Accounts', 'Balance']) {
      expect(body).not.toContain(term);
    }
  });
});
