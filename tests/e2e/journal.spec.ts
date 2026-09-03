import { expect, test, type Page } from '@playwright/test';

import { JOURNAL_STORAGE } from './constants';

/**
 * Manual journal entry — LL-035.
 *
 * Uses a DEDICATED signed-in session (the journal.setup project) so its company
 * and posting writes never race the other specs. Each test creates its own fresh
 * company (with the standard chart) so state never leaks between tests.
 *
 * The load-bearing test posts an UNBALANCED entry with the client's disabled
 * Submit forced back on — proving the server refuses regardless of the client.
 */

test.use({ storageState: JOURNAL_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Jrnl Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await page.getByPlaceholder('New company legal name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click(); // chart defaults to standard
  await expect(page.getByTestId('company-list')).toContainText(name); // now the active company
}

async function fillLine(
  page: Page,
  index: number,
  account: string,
  amounts: { debit?: string; credit?: string },
): Promise<void> {
  await page.getByTestId(`line-account-${String(index)}`).fill(account);
  if (amounts.debit !== undefined) await page.getByTestId(`line-debit-${String(index)}`).fill(amounts.debit);
  if (amounts.credit !== undefined) await page.getByTestId(`line-credit-${String(index)}`).fill(amounts.credit);
}

test('posts a balanced entry and lands on the immutable detail', async ({ page }) => {
  await freshCompany(page);
  await page.goto('/journal/new');
  await expect(page.getByTestId('journal-entry-form')).toBeVisible();

  await page.getByLabel('Transaction date').fill('2026-02-10');
  await page.getByLabel('Posting date').fill('2026-02-10');
  await page.getByLabel('Reference / description').fill('Owner funds the checking account');
  await fillLine(page, 0, 'Checking', { debit: '100.00' });
  await fillLine(page, 1, 'Sales Revenue', { credit: '100.00' });

  await expect(page.getByTestId('total-debit')).toHaveText('100.00');
  await expect(page.getByTestId('total-credit')).toHaveText('100.00');
  await expect(page.getByTestId('difference')).toHaveText('0.00');

  await page.getByTestId('post-entry').click();

  await expect(page).toHaveURL(/\/journal\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('entry-status')).toHaveText('POSTED');
  await expect(page.getByTestId('entry-lines')).toContainText('Checking');
  await expect(page.getByTestId('entry-lines')).toContainText('Sales Revenue');
  await expect(page.getByTestId('entry-description')).toContainText('Owner funds the checking account');

  // Immutable: NO edit affordance of any kind on a posted entry.
  await expect(page.getByRole('button', { name: /edit/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /edit/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
  await expect(page.locator('input')).toHaveCount(0); // nothing editable
});

test('the server rejects an unbalanced entry even when Submit is bypassed', async ({ page }) => {
  await freshCompany(page);
  await page.goto('/journal/new');

  await fillLine(page, 0, 'Checking', { debit: '100.00' });
  await fillLine(page, 1, 'Sales Revenue', { credit: '50.00' });

  await expect(page.getByTestId('difference')).toHaveText('50.00');
  // Submit is disabled as a courtesy — but that is NOT the control.
  await expect(page.getByTestId('post-entry')).toBeDisabled();

  // Force the disabled attribute off and post anyway, in one atomic step.
  await page.getByTestId('post-entry').evaluate((b: HTMLButtonElement) => {
    b.disabled = false;
    b.click();
  });

  // The server refuses; we stay on the form and no entry is created.
  await expect(page).toHaveURL(/\/journal\/new/);
  await expect(page.getByTestId('notice')).toContainText(/equal/i);
});

test('rejects posting into a closed period', async ({ page }) => {
  await freshCompany(page);

  // Post a balanced entry in January 2026 — this creates the January period.
  await page.goto('/journal/new');
  await page.getByLabel('Posting date').fill('2026-01-15');
  await fillLine(page, 0, 'Checking', { debit: '10.00' });
  await fillLine(page, 1, 'Sales Revenue', { credit: '10.00' });
  await page.getByTestId('post-entry').click();
  await expect(page).toHaveURL(/\/journal\/[0-9a-f-]{36}$/);

  // Close January.
  await page.goto('/periods');
  const janRow = page.getByRole('row').filter({ hasText: '2026-01-01' });
  await janRow.getByRole('button', { name: 'Close' }).click();
  await janRow.getByRole('button', { name: /Confirm close/i }).click();
  await expect(janRow).toContainText('CLOSED');

  // Attempt another entry whose POSTING date lands in the now-closed January.
  await page.goto('/journal/new');
  await page.getByLabel('Posting date').fill('2026-01-20');
  await fillLine(page, 0, 'Checking', { debit: '5.00' });
  await fillLine(page, 1, 'Sales Revenue', { credit: '5.00' });
  await page.getByTestId('post-entry').click();

  await expect(page).toHaveURL(/\/journal\/new/);
  await expect(page.getByTestId('notice')).toContainText(/closed period/i);
});

test('the account picker cannot surface another company’s account', async ({ page }) => {
  // Company B, with a distinctively-named custom account.
  await freshCompany(page);
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'New account' }).click();
  await page.getByPlaceholder('Account name').fill('Zzz Secret Bravo Account');
  await page.getByRole('combobox').selectOption('ASSET');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('accounts-table')).toContainText('Zzz Secret Bravo Account');

  // Company A becomes active; its journal picker must not see B's account.
  await freshCompany(page);
  await page.goto('/journal/new');
  const optionValues = await page
    .locator('#account-options option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));

  expect(optionValues.some((v) => v.includes('Zzz Secret Bravo Account'))).toBe(false);
  expect(optionValues.some((v) => v.includes('Checking'))).toBe(true); // A's own chart is present
});
