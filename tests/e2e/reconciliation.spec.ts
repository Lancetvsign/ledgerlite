import { expect, test, type Page } from '@playwright/test';

import { RECONCILIATION_STORAGE } from './constants';

/**
 * Bank reconciliation UI — LL-078. Imports the canned statement (BANK_IMPORT_TEST_EXTRACTOR=1),
 * posts two lines into Checking, then reconciles a statement at the exact figure: imported
 * rows are pre-ticked, saving makes the difference 0.0000, Complete is accepted. A wrong
 * figure shows the difference and Complete stays disabled.
 */
test.use({ storageState: RECONCILIATION_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Recon Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await page.getByPlaceholder('New company legal name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click(); // standard chart: Checking is CASH
  await expect(page.getByTestId('company-list')).toContainText(name);
}

/** Canned statement → post lines 0 and 1 (1500 / −120.50) into Checking, ignore line 2. */
async function importTwoLines(page: Page): Promise<void> {
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '1000 · Checking' });
  await page.getByTestId('upload-file').setInputFiles({ name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
  await page.getByTestId('import-action-2').selectOption('ignore');
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 2 line(s), ignored 1');
}

test('reconcile Checking against the statement: pre-ticked imports, zero difference, complete', async ({ page }) => {
  await freshCompany(page);
  await importTwoLines(page);

  await page.goto('/reconciliation');
  await page.getByTestId('recon-account').selectOption({ label: '1000 · Checking' });
  await page.getByTestId('recon-date').fill('2026-06-30');
  await page.getByTestId('recon-amount').fill('1379.50');
  await page.getByTestId('recon-start').click();
  await expect(page).toHaveURL(/\/reconciliation\/[0-9a-f-]{36}$/);

  await expect(page.getByTestId('recon-status')).toHaveText('IN_PROGRESS');
  await expect(page.getByTestId('recon-statement')).toHaveText('1379.5000');
  await expect(page.getByTestId('recon-difference')).toHaveText('1379.5000'); // nothing saved yet
  await expect(page.getByTestId('recon-line-row')).toHaveCount(2);
  await expect(page.getByTestId('recon-tick-0')).toBeChecked(); // from statement import → pre-ticked
  await expect(page.getByTestId('recon-tick-1')).toBeChecked();
  await expect(page.getByTestId('recon-complete')).toBeDisabled();

  await page.getByTestId('recon-save').click();
  await expect(page.getByTestId('notice')).toContainText('Saved 2 cleared line(s)');
  await expect(page.getByTestId('recon-here')).toHaveText('1379.5000');
  await expect(page.getByTestId('recon-difference')).toHaveText('0.0000');
  await expect(page.getByTestId('recon-complete')).toBeEnabled();

  await page.getByTestId('recon-complete').click();
  await expect(page.getByTestId('notice')).toContainText('Reconciliation completed');
  await expect(page.getByTestId('recon-status')).toHaveText('COMPLETED');
  await expect(page.getByTestId('recon-save')).toHaveCount(0); // final: no more edits

  await page.goto('/reconciliation');
  await expect(page.getByTestId('recon-row')).toHaveCount(1);
  await expect(page.getByTestId('recon-row')).toHaveAttribute('data-status', 'COMPLETED');
});

test('a wrong statement figure leaves a difference and Complete disabled; correcting it fixes both', async ({ page }) => {
  await freshCompany(page);
  await importTwoLines(page);

  await page.goto('/reconciliation');
  await page.getByTestId('recon-account').selectOption({ label: '1000 · Checking' });
  await page.getByTestId('recon-date').fill('2026-06-30');
  await page.getByTestId('recon-amount').fill('1400.00');
  await page.getByTestId('recon-start').click();
  await page.getByTestId('recon-save').click();
  await expect(page.getByTestId('recon-difference')).toHaveText('20.5000');
  await expect(page.getByTestId('recon-complete')).toBeDisabled();

  await page.getByTestId('recon-edit-amount').fill('1379.50');
  await page.getByTestId('recon-update').click();
  await expect(page.getByTestId('notice')).toContainText('Statement details updated');
  await expect(page.getByTestId('recon-difference')).toHaveText('0.0000');
  await expect(page.getByTestId('recon-complete')).toBeEnabled();
});

test.describe('unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the reconciliation pages redirect to sign-in', async ({ page }) => {
    await page.goto('/reconciliation');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
