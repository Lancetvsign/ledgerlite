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

async function addCustomer(page: Page, name: string): Promise<void> {
  await page.goto('/customers');
  await page.getByTestId('customer-name').fill(name);
  await page.getByTestId('add-customer').click();
  await expect(page.getByTestId('customers-table')).toContainText(name);
}

/** Create + finalize an invoice; returns its id (status OPEN). */
async function openInvoice(page: Page, customer: string, price: string): Promise<string> {
  await page.goto('/invoices/new');
  await page.getByTestId('invoice-customer').fill(customer);
  await page.getByTestId('line-account-0').fill('Sales Revenue');
  await page.getByTestId('line-qty-0').fill('1');
  await page.getByTestId('line-price-0').fill(price);
  await page.getByTestId('save-invoice').click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop() ?? '';
  await page.getByTestId('finalize-invoice').click();
  await expect(page.getByTestId('invoice-status')).toHaveText('OPEN');
  return id;
}

async function addVendor(page: Page, name: string): Promise<void> {
  await page.goto('/vendors');
  await page.getByTestId('vendor-name').fill(name);
  await page.getByTestId('add-vendor').click();
  await expect(page.getByTestId('vendors-table')).toContainText(name);
}

/** Create + finalize a bill against Office Supplies; returns its id (OPEN). */
async function openBill(page: Page, vendor: string, price: string): Promise<string> {
  await page.goto('/bills/new');
  await page.getByTestId('bill-vendor').fill(vendor);
  await page.getByTestId('line-account-0').fill('Office Supplies');
  await page.getByTestId('line-qty-0').fill('1');
  await page.getByTestId('line-price-0').fill(price);
  await page.getByTestId('save-bill').click();
  await expect(page).toHaveURL(/\/bills\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop() ?? '';
  await page.getByTestId('finalize-bill').click();
  await expect(page.getByTestId('bill-status')).toHaveText('OPEN');
  return id;
}

/** Upload the canned statement into Checking; returns the review URL's batch id. */
async function uploadStatement(page: Page): Promise<void> {
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '1000 · Checking' });
  await page.getByTestId('upload-file').setInputFiles({ name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
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
  await expect(page.getByTestId('import-amount-0')).toHaveText('1,500.00');
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
  await expect(page.getByTestId('dashboard-cash')).toHaveText('1,379.50');
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

test('applies a deposit to an open invoice and a payment to an open bill (LL-077)', async ({ page }) => {
  await freshCompany(page);
  await addCustomer(page, 'Acme Corp');
  const invoiceId = await openInvoice(page, 'Acme Corp', '1500.00'); // matches the +1500 deposit
  await addVendor(page, 'Office Depot');
  const billId = await openBill(page, 'Office Depot', '120.50'); // matches the −120.50 payment

  await uploadStatement(page);
  // Amount-match suggestions: the invoice and the bill are preselected with the apply action;
  // the rent line has no match and defaults to a category post.
  await expect(page.getByTestId('import-document-0').locator('option:checked')).toContainText('Acme Corp');
  await expect(page.getByTestId('import-action-0')).toHaveValue('apply_invoice');
  await expect(page.getByTestId('import-document-1').locator('option:checked')).toContainText('Office Depot');
  await expect(page.getByTestId('import-action-1')).toHaveValue('apply_bill');
  await expect(page.getByTestId('import-action-2')).toHaveValue('post');

  await page.getByTestId('import-action-2').selectOption('ignore');
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 2 line(s), ignored 1');
  await expect(page.getByTestId('notice')).toContainText('2 applied');
  await expect(page.getByTestId('import-applied-0')).toContainText('applied to payment');
  await expect(page.getByTestId('import-applied-1')).toContainText('applied to bill payment');

  // The documents are settled by real payments; A/R and A/P are back to zero.
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByTestId('invoice-status')).toHaveText('PAID');
  await page.goto(`/bills/${billId}`);
  await expect(page.getByTestId('bill-status')).toHaveText('PAID');
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-ar')).toHaveText('0.00');
  await expect(page.getByTestId('dashboard-ap')).toHaveText('0.00');
  await expect(page.getByTestId('dashboard-cash')).toHaveText('1,379.50');
});

test.describe('unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the import pages redirect to sign-in', async ({ page }) => {
    await page.goto('/bank-import');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
