import { expect, test, type Page } from '@playwright/test';

import { BANK_IMPORT_STORAGE } from './constants';

/**
 * Bank-statement import UI — LL-076a. Drives the real upload → review → post loop with the
 * extractor stubbed to a canned statement (BANK_IMPORT_TEST_EXTRACTOR=1 on the e2e server;
 * the real AI extractor is non-deterministic and needs a key, so it is never exercised in
 * CI). Asserts the suggested accounts, a per-line change, an ignore, and that the posted
 * lines reach the ledger as the exact NUMERIC(19,4) strings.
 */
test.use({ storageState: BANK_IMPORT_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Bank Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await page.getByPlaceholder('New company legal name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click(); // standard chart: Checking is CASH
  await expect(page.getByTestId('company-list')).toContainText(name);
}

test('upload, review (change + ignore), post, and see it in the ledger', async ({ page }) => {
  await freshCompany(page);

  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '1000 · Checking' });
  await page.getByTestId('upload-file').setInputFiles({
    name: 'june-statement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 synthetic statement for e2e'),
  });
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);

  // The canned statement: deposit +1500 (Sales Revenue), Office Depot −120.50 (Office
  // Supplies), rent −2000 (Rent) — suggestions mapped from the extractor's categories.
  await expect(page.getByTestId('import-line-row')).toHaveCount(3);
  await expect(page.getByTestId('import-amount-0')).toHaveText('1500.0000');
  await expect(page.getByTestId('import-account-0')).toHaveValue(/./); // Sales Revenue preselected
  await expect(page.getByTestId('import-account-0').locator('option:checked')).toHaveText('4000 · Sales Revenue');
  await expect(page.getByTestId('import-account-1').locator('option:checked')).toHaveText('6300 · Office Supplies');

  // Change line 2 to Utilities, ignore line 3, post.
  await page.getByTestId('import-account-1').selectOption({ label: '6800 · Utilities' });
  await page.getByTestId('import-action-2').selectOption('ignore');
  await page.getByTestId('post-import-lines').click();

  await expect(page.getByTestId('notice')).toContainText('Posted 2 line(s), ignored 1');
  await expect(page.getByTestId('import-status-0')).toHaveText('POSTED');
  await expect(page.getByTestId('import-status-1')).toHaveText('POSTED');
  await expect(page.getByTestId('import-status-2')).toHaveText('IGNORED');

  // The ledger reflects it: Checking = +1500 − 120.50 (rent ignored) on the dashboard.
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-cash')).toHaveText('1379.5000');
  await expect(page.getByTestId('dashboard-recent-row')).toHaveCount(2);
});

test('a second upload of the same statement flags duplicates', async ({ page }) => {
  await freshCompany(page);
  const upload = async () => {
    await page.goto('/bank-import');
    await page.getByTestId('upload-bank-account').selectOption({ label: '1000 · Checking' });
    await page.getByTestId('upload-file').setInputFiles({ name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
    await page.getByTestId('upload-submit').click();
    await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
  };
  await upload();
  await page.getByTestId('post-import-lines').click(); // post all three (suggestions preselected)
  await expect(page.getByTestId('notice')).toContainText('Posted 3');

  await upload();
  await expect(page.getByTestId('duplicate-flag')).toHaveCount(3);
});

test.describe('unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the import pages redirect to sign-in', async ({ page }) => {
    await page.goto('/bank-import');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
