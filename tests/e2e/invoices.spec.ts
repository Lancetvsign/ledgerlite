import { expect, test, type Page } from '@playwright/test';

import { INVOICES_STORAGE } from './constants';

/**
 * Invoice UI — LL-044.
 *
 * A dedicated signed-in session, and each test creates its own fresh company (with
 * the standard chart, so Accounts Receivable and revenue accounts exist for
 * finalize). Covers the full lifecycle end-to-end in a real browser — add a
 * customer, draft an invoice, finalize it (posts to the GL), void it — and proves
 * the customer picker is company-scoped.
 */
test.use({ storageState: INVOICES_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Inv Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await page.getByPlaceholder('New company legal name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click(); // chart defaults to standard
  await expect(page.getByTestId('company-list')).toContainText(name);
}

async function addCustomer(page: Page, name: string): Promise<void> {
  await page.goto('/customers');
  await page.getByTestId('customer-name').fill(name);
  await page.getByTestId('add-customer').click();
  await expect(page.getByTestId('customers-table')).toContainText(name);
}

test('draft → finalize → void, end to end', async ({ page }) => {
  await freshCompany(page);
  await addCustomer(page, 'Acme LLC');

  // Draft an invoice for the customer against a standard-chart revenue account.
  await page.goto('/invoices/new');
  await expect(page.getByTestId('invoice-form')).toBeVisible();
  await page.getByTestId('invoice-customer').fill('Acme LLC');
  await page.getByTestId('line-account-0').fill('Sales Revenue');
  await page.getByTestId('line-qty-0').fill('2');
  await page.getByTestId('line-price-0').fill('100.00');
  await expect(page.getByTestId('grand-total')).toHaveText('200.00'); // advisory, no tax

  await page.getByTestId('save-invoice').click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('invoice-status')).toHaveText('DRAFT');
  await expect(page.getByTestId('invoice-customer-name')).toHaveText('Acme LLC');
  await expect(page.getByTestId('invoice-total')).toHaveText('200.0000');

  // Finalize — assigns a number, posts to the GL, status → OPEN.
  await page.getByTestId('finalize-invoice').click();
  await expect(page.getByTestId('invoice-status')).toHaveText('OPEN');
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('(draft)');
  await expect(page.getByTestId('notice')).toContainText(/posted to the ledger/i);

  // Void — reverses the entry, status → VOID.
  await page.getByTestId('void-invoice').click();
  await expect(page.getByTestId('invoice-status')).toHaveText('VOID');
  await expect(page.getByTestId('notice')).toContainText(/reversed/i);
});

test('the customer picker cannot surface another company’s customer', async ({ page }) => {
  // Company B, with a distinctively-named customer.
  await freshCompany(page);
  await addCustomer(page, 'Zzz Secret Bravo Customer');

  // Company A becomes active; its invoice picker must not see B's customer.
  await freshCompany(page);
  await page.goto('/invoices/new');
  const optionValues = await page
    .locator('#customer-options option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(optionValues.some((v) => v.includes('Zzz Secret Bravo Customer'))).toBe(false);
});
