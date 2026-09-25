import { expect, test, type Page } from '@playwright/test';

import { BANK_IMPORT_STORAGE } from './constants';

/**
 * Bank-statement import UI — LL-076a.
 * Post/apply assertions allow 15 s: the action posts several ledger entries (and, for LL-077,
 * runs the payment cores) on CI's shared Neon compute, which can exceed the 5 s default. Drives the real upload → review → post loop with the
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

  await expect(page.getByTestId('notice')).toContainText('Posted 2 line(s), ignored 1', { timeout: 15_000 });
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
  await expect(page.getByTestId('notice')).toContainText('Posted 3', { timeout: 15_000 });

  await upload();
  await expect(page.getByTestId('duplicate-flag')).toHaveCount(3);
});

test('applies a deposit to an open invoice and a payment to an open bill (LL-077)', async ({ page }) => {
  test.slow(); // eight screens end to end; CI's shared compute makes 30s too tight
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
  await expect(page.getByTestId('notice')).toContainText('Posted 2 line(s), ignored 1', { timeout: 15_000 });
  await expect(page.getByTestId('notice')).toContainText('2 applied', { timeout: 15_000 });
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

test('a mistaken upload can be deleted until something posts (LL-087)', async ({ page }) => {
  await freshCompany(page);
  await uploadStatement(page);
  const reviewUrl = page.url();
  await page.locator('summary', { hasText: 'Delete this import' }).click();
  await page.getByTestId('delete-import-batch').click();
  await expect(page).toHaveURL(/\/bank-import\?ok=deleted$/);
  await expect(page.getByTestId('notice')).toContainText('Import deleted');
  await expect(page.getByTestId('no-batches')).toBeVisible();
  await page.goto(reviewUrl);
  await expect(page.getByTestId('notice')).toContainText('does not exist');

  // Once a line has posted, the control is gone and the service refuses.
  await uploadStatement(page);
  await page.getByTestId('import-action-1').selectOption('ignore');
  await page.getByTestId('import-action-2').selectOption('ignore');
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 1 line(s), ignored 2', { timeout: 15_000 });
  await expect(page.getByTestId('delete-import-batch')).toHaveCount(0);
});

test('review choices survive leaving the page, and the list shows In progress → Complete (LL-105)', async ({ page }) => {
  await freshCompany(page);
  await uploadStatement(page);
  const reviewUrl = page.url();
  await expect(page.getByTestId('review-status')).toHaveText('New');

  // Change an account and ignore a line; the autosaver reports the save.
  await page.getByTestId('import-account-1').selectOption({ label: '6800 · Utilities' });
  await page.getByTestId('import-action-2').selectOption('ignore');
  await expect(page.getByTestId('autosave-status')).toContainText('Saved', { timeout: 10_000 });

  // Leave: the list shows the statement in progress …
  await page.goto('/bank-import');
  await expect(page.getByTestId('batch-status')).toHaveText('In progress');
  await expect(page.getByTestId('batch-status')).toHaveAttribute('data-status', 'in_progress');

  // … and coming back restores every choice, including the ignore's Undo state.
  await page.goto(reviewUrl);
  await expect(page.getByTestId('review-status')).toHaveText('In progress');
  await expect(page.getByTestId('import-account-1').locator('option:checked')).toHaveText('6800 · Utilities');
  await expect(page.getByTestId('import-action-2')).toHaveValue('ignore');
  await expect(page.getByTestId('ignore-line-2')).toHaveText('Undo');
  await expect(page.getByTestId('review-counts')).toHaveText('2 to post · 1 to ignore');

  // "Reset to suggestions" still means the suggestions, and is saved too.
  await page.getByTestId('reset-all').click();
  await expect(page.getByTestId('import-action-2')).toHaveValue('post');
  await expect(page.getByTestId('autosave-status')).toContainText('Saved', { timeout: 10_000 });
  await page.getByTestId('import-action-2').selectOption('ignore');
  await expect(page.getByTestId('autosave-status')).toContainText('Saved', { timeout: 10_000 });

  // Post: the drafts are gone with the decisions and the statement is complete.
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 2 line(s), ignored 1', { timeout: 15_000 });
  await expect(page.getByTestId('review-status')).toHaveText('Complete');
  await page.goto('/bank-import');
  await expect(page.getByTestId('batch-status')).toHaveText('Complete');
});

test('a misread amount is corrected before posting; the ledger carries the corrected figure (LL-107)', async ({ page }) => {
  await freshCompany(page);
  await uploadStatement(page);
  // The canned statement's Office Depot line reads −120.50; suppose the parser dropped a digit.
  await expect(page.getByTestId('import-amount-1')).toHaveText('-120.50');
  await expect(page.getByTestId('amended-flag-1')).toHaveCount(0);
  await page.getByTestId('amend-amount-1').click();
  await page.getByTestId('amend-amount-input-1').fill('-1,120.50');
  await page.getByTestId('amend-amount-save-1').click();
  await expect(page.getByTestId('notice')).toContainText('Amount corrected', { timeout: 15_000 });
  await expect(page.getByTestId('import-amount-1')).toHaveText('-1,120.50');
  await expect(page.getByTestId('amended-flag-1')).toContainText('corrected from -120.50');

  // A malformed figure is refused with a clear message; the line is unchanged.
  await page.getByTestId('amend-amount-1').click();
  await page.getByTestId('amend-amount-input-1').fill('0');
  await page.getByTestId('amend-amount-save-1').click();
  await expect(page.getByTestId('notice')).toContainText('Enter the signed statement amount');
  await expect(page.getByTestId('import-amount-1')).toHaveText('-1,120.50');

  // Post all three (suggestions preselected): the ledger carries the corrected figure.
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 3', { timeout: 15_000 });
  await expect(page.getByTestId('amend-amount-1')).toHaveCount(0); // decided lines cannot be edited
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-cash')).toHaveText('-1,620.50'); // 1500 − 1120.50 − 2000
});

test('a credit-card statement imports into the card account and increases what is owed (LL-088)', async ({ page }) => {
  await freshCompany(page);
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '2100 · Credit Card' });
  await page.getByTestId('upload-file').setInputFiles({ name: 'visa.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('card-statement')).toBeVisible();
  await expect(page.getByTestId('import-document-0')).toHaveCount(0); // no apply-to-document on a card
  await expect(page.getByTestId('import-action-0').locator('option[value="apply_invoice"]')).toHaveCount(0);

  // Canned CARD statement: −120.50 (Office Supplies), −45 (Travel & Meals), +2000 payment (no
  // category — it came from Checking, which is not imported in this test). Post all.
  await page.getByTestId('import-account-2').selectOption({ label: '1000 · Checking' });
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 3', { timeout: 15_000 });

  // Card (credit-normal) = 120.50 + 45 − 2000 = −1,834.50 (paid ahead); books balance.
  await page.goto('/reports/trial-balance');
  await expect(page.getByTestId('trial-balance-row').filter({ hasText: 'Credit Card' })).toContainText('-1,834.50');
  await expect(page.getByTestId('tb-balanced')).toContainText('Balanced');
});

test('a transfer imported from both statements posts once — the card side is matched, not re-posted (LL-094)', async ({ page }) => {
  await freshCompany(page);
  // Bank statement: the −2000 "rent" line is the card payment → categorise it to the card and post all.
  await uploadStatement(page);
  await page.getByTestId('import-account-2').selectOption({ label: '2100 · Credit Card' });
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 3', { timeout: 15_000 });

  // Card statement: the +2000 payment is flagged as the already-posted transfer and defaults to Match.
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '2100 · Credit Card' });
  await page.getByTestId('upload-file').setInputFiles({ name: 'visa.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('transfer-flag')).toHaveCount(1);
  await expect(page.getByTestId('transfer-flag')).toContainText('transfer already posted from 1000 · Checking');
  await expect(page.getByTestId('import-action-2')).toHaveValue('match_transfer');
  await expect(page.getByTestId('review-counts')).toHaveText('3 to post · 0 to ignore');

  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 2 line(s), ignored 0. 1 matched to a transfer', { timeout: 15_000 });
  await expect(page.getByTestId('import-status-2')).toHaveText('POSTED');

  // One movement, not two: Checking 1500 − 120.50 − 2000 = −620.50; Card 120.50 + 45 − 2000 = −1,834.50.
  await page.goto('/reports/trial-balance');
  await expect(page.getByTestId('trial-balance-row').filter({ hasText: 'Checking' })).toContainText('-620.50');
  await expect(page.getByTestId('trial-balance-row').filter({ hasText: 'Credit Card' })).toContainText('-1,834.50');
  await expect(page.getByTestId('tb-balanced')).toContainText('Balanced');
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-recent-row')).toHaveCount(5); // 3 bank + 2 card purchases
});

test('ignore all remaining, undo one, and post only that line (LL-089)', async ({ page }) => {
  await freshCompany(page);
  await uploadStatement(page);
  await expect(page.getByTestId('review-counts')).toHaveText('3 to post · 0 to ignore');

  await page.getByTestId('ignore-all').click();
  await expect(page.getByTestId('review-counts')).toHaveText('0 to post · 3 to ignore');
  for (const i of [0, 1, 2]) await expect(page.getByTestId(`import-action-${String(i)}`)).toHaveValue('ignore');

  await page.getByTestId('reset-all').click();
  await expect(page.getByTestId('review-counts')).toHaveText('3 to post · 0 to ignore');

  await page.getByTestId('ignore-all').click();
  await page.getByTestId('ignore-line-1').click(); // Undo: back to the suggestion for line 2
  await expect(page.getByTestId('review-counts')).toHaveText('1 to post · 2 to ignore');
  await expect(page.getByTestId('import-action-1')).toHaveValue('post');

  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 1 line(s), ignored 2', { timeout: 15_000 });
  await expect(page.getByTestId('import-status-0')).toHaveText('IGNORED');
  await expect(page.getByTestId('import-status-1')).toHaveText('POSTED');
  await expect(page.getByTestId('import-status-2')).toHaveText('IGNORED');
});

test('a shared card statement is split: one line posted here, one marked personal, one taken by the other company (LL-097)', async ({ page }) => {
  test.slow();
  // Two fresh companies in one organization; the second (Card Co) holds the card.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const taker = `Taker Co ${stamp}`;
  const cardCo = `Card Co ${stamp}`;
  await page.goto('/account');
  for (const name of [taker, cardCo]) {
    await page.getByPlaceholder('New company legal name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('company-list')).toContainText(name, { timeout: 15_000 });
  }
  const takerRow = page.locator('li', { hasText: taker });
  await takerRow.getByTestId('organization-menu').click();
  await takerRow.getByPlaceholder('Organization name').fill(`Group ${stamp}`);
  await takerRow.getByTestId('create-organization').click();
  await expect(page.getByTestId('notice')).toContainText('Organization created');
  const cardRow = page.locator('li', { hasText: cardCo });
  await cardRow.getByTestId('organization-menu').click();
  await cardRow.getByTestId('organization-select').selectOption({ label: `Group ${stamp}` });
  await cardRow.getByTestId('add-to-organization').click();
  await expect(page.getByTestId('notice')).toContainText('joined the organization');
  await expect(page.locator('li', { hasText: cardCo }).getByTestId('active-badge')).toBeVisible(); // created last → active

  // Card Co: upload the canned card statement, shared. Post OFFICE DEPOT, mark SHELL FUEL personal.
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '2100 · Credit Card' });
  await page.getByTestId('upload-file').setInputFiles({ name: 'visa.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await page.getByTestId('upload-share').check();
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('sharing-status')).toContainText('Shared with your organization');
  await page.getByTestId('import-action-1').selectOption('personal');
  await expect(page.getByTestId('import-account-1')).toHaveValue(/./);
  await expect(page.getByTestId('import-account-1').locator('option:checked')).toHaveText(/Owner Distributions/);
  await page.getByTestId('import-action-2').selectOption('ignore'); // the card payment is not taken here
  await expect(page.getByTestId('review-counts')).toHaveText('1 to post · 1 to ignore · 1 personal');
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Posted 1 line(s), ignored 1. 1 marked personal.', { timeout: 15_000 });
  await expect(page.getByTestId('import-status-1')).toHaveText('PERSONAL');
  await expect(page.getByTestId('delete-import-batch')).toHaveCount(0);

  // Taker Co: the statement is "shared with you"; the untaken lines are the ignored payment? No — ignored lines
  // are not offered; nothing is left to take, so make the card owner un-ignore by re-uploading… simpler: use a
  // second statement upload that stays fully staged.
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '2100 · Credit Card' });
  await page.getByTestId('upload-file').setInputFiles({ name: 'visa2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 y') });
  await page.getByTestId('upload-share').check();
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);

  await page.goto('/account');
  await page.locator('li', { hasText: taker }).getByRole('button', { name: 'Switch' }).click();
  await expect(page.locator('li', { hasText: taker }).getByTestId('active-badge')).toBeVisible();
  await page.goto('/bank-import');
  await expect(page.getByTestId('shared-list')).toContainText(cardCo);
  await page.getByTestId('shared-link').first().click(); // newest first: the fully staged second statement
  await expect(page).toHaveURL(/\/bank-import\/shared\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('shared-line-row')).toHaveCount(3);
  await page.getByTestId('shared-take-1').check(); // SHELL FUEL −45.00
  const suppliesOption = await page.getByTestId('shared-account-1').locator('option', { hasText: 'Office Supplies' }).first().getAttribute('value');
  await page.getByTestId('shared-account-1').selectOption(suppliesOption ?? '');
  await page.getByTestId('assign-shared-lines').click();
  await expect(page.getByTestId('notice')).toContainText('Took 1 line(s)', { timeout: 15_000 });
  await expect(page.getByTestId('shared-taken-1')).toBeVisible();

  // Taker Co's books: the expense and Due to Card Co; balanced.
  await page.goto('/reports/trial-balance');
  await expect(page.getByTestId('trial-balance-row').filter({ hasText: 'Due to' })).toContainText('45.00');
  await expect(page.getByTestId('tb-balanced')).toContainText('Balanced');

  // Give it back: both entries reversed, the line is available again.
  await page.goto('/bank-import');
  await page.getByTestId('shared-link').first().click(); // newest first: the fully staged second statement
  await page.getByTestId('shared-undo-1').click();
  await expect(page.getByTestId('notice')).toContainText('Line given back', { timeout: 15_000 });
  await expect(page.getByTestId('shared-taken-1')).toHaveCount(0);
  await expect(page.getByTestId('shared-take-1')).toBeVisible();
});

test('an intercompany bank transfer is marked in one company and matched from the other (LL-099)', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const payee = `Payee Co ${stamp}`;
  const payer = `Payer Co ${stamp}`;
  await page.goto('/account');
  for (const name of [payee, payer]) {
    await page.getByPlaceholder('New company legal name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('company-list')).toContainText(name, { timeout: 15_000 });
  }
  const payeeRow = page.locator('li', { hasText: payee });
  await payeeRow.getByTestId('organization-menu').click();
  await payeeRow.getByPlaceholder('Organization name').fill(`Group ${stamp}`);
  await payeeRow.getByTestId('create-organization').click();
  await expect(page.getByTestId('notice')).toContainText('Organization created');
  const payerRow = page.locator('li', { hasText: payer });
  await payerRow.getByTestId('organization-menu').click();
  await payerRow.getByTestId('organization-select').selectOption({ label: `Group ${stamp}` });
  await payerRow.getByTestId('add-to-organization').click();
  await expect(page.getByTestId('notice')).toContainText('joined the organization');

  // Payer Co (active): the canned bank statement's −2000 "rent" line is really a transfer to Payee Co.
  await uploadStatement(page);
  await page.getByTestId('import-action-2').selectOption('intercompany_transfer');
  await expect(page.getByTestId('import-counterpart-2')).toBeVisible();
  await page.getByTestId('import-counterpart-2').selectOption({ label: `${payee} — no statement line found` }); // LL-106: no statement of Payee mirrors it yet
  await page.getByTestId('import-action-0').selectOption('ignore');
  await page.getByTestId('import-action-1').selectOption('ignore');
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('1 posted as intercompany transfers', { timeout: 15_000 });
  await page.goto('/reports/intercompany');
  await expect(page.getByTestId('intercompany-row').filter({ hasText: payee })).toContainText('2,000.00');
  await expect(page.getByTestId('intercompany-mirrored')).toContainText('In transit'); // LL-101: never "Mirrored" while a mark awaits its match

  // Payee Co: its card statement's +2000 PAYMENT line is the other side; it is flagged and defaults to Match.
  await page.goto('/account');
  await page.locator('li', { hasText: payee }).getByRole('button', { name: 'Switch' }).click();
  await expect(page.locator('li', { hasText: payee }).getByTestId('active-badge')).toBeVisible();
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '2100 · Credit Card' });
  await page.getByTestId('upload-file').setInputFiles({ name: 'visa.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('intercompany-flag')).toContainText(`transfer posted by ${payer}`);
  await expect(page.getByTestId('import-action-2')).toHaveValue('match_intercompany');
  await page.getByTestId('import-action-0').selectOption('ignore');
  await page.getByTestId('import-action-1').selectOption('ignore');
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('1 posted as intercompany transfers', { timeout: 15_000 });
  const payeeReviewUrl = page.url().split('?')[0] ?? page.url();

  await page.goto('/reports/intercompany');
  const row = page.getByTestId('intercompany-row').filter({ hasText: payer });
  await expect(row).toContainText('2,000.00');
  await expect(row).toHaveAttribute('data-mirrored', '1');
  await expect(page.getByTestId('intercompany-mirrored')).toContainText('Mirrored');

  // Undo from the payee (LL-100): both sides reversed, the line is back for review here.
  await page.goto(payeeReviewUrl);
  await page.getByTestId('unmark-transfer-2').click();
  await expect(page.getByTestId('notice')).toContainText('Transfer un-marked', { timeout: 15_000 });
  await expect(page.getByTestId('import-action-2')).toBeVisible();
  await page.goto('/reports/intercompany');
  await expect(page.getByTestId('intercompany-row').filter({ hasText: payer })).toContainText('0.00');
});

test('a card payment finds the paying company on its statement, waits while there is none, and both sides mirror (LL-106)', async ({ page, browser }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const holder = `Holder Co ${stamp}`; // the cardholder
  const payer = `Payer Co ${stamp}`; // pays the card from its bank
  await page.goto('/account');
  for (const name of [payer, holder]) {
    await page.getByPlaceholder('New company legal name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('company-list')).toContainText(name, { timeout: 15_000 });
  }
  const holderRow = page.locator('li', { hasText: holder });
  await holderRow.getByTestId('organization-menu').click();
  await holderRow.getByPlaceholder('Organization name').fill(`Group ${stamp}`);
  await holderRow.getByTestId('create-organization').click();
  await expect(page.getByTestId('notice')).toContainText('Organization created');
  const payerRow = page.locator('li', { hasText: payer });
  await payerRow.getByTestId('organization-menu').click();
  await payerRow.getByTestId('organization-select').selectOption({ label: `Group ${stamp}` });
  await payerRow.getByTestId('add-to-organization').click();
  await expect(page.getByTestId('notice')).toContainText('joined the organization');

  // Holder Co (active): the card statement's +2000 PAYMENT — nobody's statement mirrors it yet, so
  // "Paid by another company" WAITS instead of guessing; the wait is saved and the submit skips it.
  await page.goto('/bank-import');
  await page.getByTestId('upload-bank-account').selectOption({ label: '2100 · Credit Card' });
  await page.getByTestId('upload-file').setInputFiles({ name: 'visa.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(/\/bank-import\/[0-9a-f-]{36}$/);
  const holderReviewUrl = page.url();
  await expect(page.getByTestId('organization-match-flag')).toHaveCount(0);
  await page.getByTestId('import-action-2').selectOption({ label: 'Paid by another company…' });
  await expect(page.getByTestId('waiting-flag-2')).toBeVisible();
  await expect(page.getByTestId('autosave-status')).toContainText('Saved', { timeout: 10_000 });
  await page.getByTestId('import-action-0').selectOption('ignore');
  await page.getByTestId('import-action-1').selectOption('ignore');
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('1 still waiting for another company', { timeout: 15_000 });
  await expect(page.getByTestId('import-action-2')).toHaveValue('intercompany_transfer'); // still staged, still waiting
  await expect(page.getByTestId('waiting-count')).toContainText('1 waiting');

  // Payer Co, in a SECOND browser context (its own active-company cookie), uploads its bank
  // statement — staged, not reviewed — which carries the −2000 that paid the card. Holder Co's
  // review page stays open in the first context, still waiting.
  const payerContext = await browser.newContext({ storageState: await page.context().storageState() });
  const payerPage = await payerContext.newPage();
  await payerPage.goto('/account');
  await payerPage.locator('li', { hasText: payer }).getByRole('button', { name: 'Switch' }).click();
  await expect(payerPage.locator('li', { hasText: payer }).getByTestId('active-badge')).toBeVisible();
  await uploadStatement(payerPage);
  const payerReviewUrl = payerPage.url();

  // The live path: "Check again" re-reads the server and the waiting row adopts the match found
  // on Payer Co's statement — no reload, no company picked by hand.
  await expect(page.getByTestId('waiting-flag-2')).toBeVisible();
  await page.getByTestId('check-again').click();
  await expect(page.getByTestId('organization-match-flag')).toContainText(`on ${payer}'s Checking statement`, { timeout: 15_000 });
  await expect(page.getByTestId('waiting-flag-2')).toHaveCount(0);
  await expect(page.getByTestId('import-counterpart-2')).toHaveValue(/^line:/);
  await expect(page.getByTestId('import-action-2')).toHaveValue('intercompany_transfer');
  // A full reload preselects it the same way (the draft's company, the found line).
  await page.goto(holderReviewUrl);
  await expect(page.getByTestId('import-counterpart-2')).toHaveValue(/^line:/);
  await expect(page.getByTestId('waiting-flag-2')).toHaveCount(0);
  await expect(page.getByTestId('import-action-2')).toHaveValue('intercompany_transfer'); // the draft
  await expect(page.getByTestId('import-counterpart-2')).toHaveValue(/^line:/); // preselected: the statement line, not a guess
  await expect(page.getByTestId('waiting-flag-2')).toHaveCount(0);
  await page.getByTestId('post-import-lines').click();
  await expect(page.getByTestId('notice')).toContainText('1 posted as intercompany transfers', { timeout: 15_000 });

  // Payer Co's own review now offers Holder Co's posted side; matching it mirrors the pair.
  await payerPage.goto(payerReviewUrl);
  await expect(payerPage.getByTestId('intercompany-flag')).toContainText(`transfer posted by ${holder}`);
  await expect(payerPage.getByTestId('import-action-2')).toHaveValue('match_intercompany');
  await payerPage.getByTestId('import-action-0').selectOption('ignore');
  await payerPage.getByTestId('import-action-1').selectOption('ignore');
  await payerPage.getByTestId('post-import-lines').click();
  await expect(payerPage.getByTestId('notice')).toContainText('1 posted as intercompany transfers', { timeout: 15_000 });
  await payerPage.goto('/reports/intercompany');
  const row = payerPage.getByTestId('intercompany-row').filter({ hasText: holder });
  await expect(row).toContainText('2,000.00');
  await expect(row).toHaveAttribute('data-mirrored', '1');
  await payerContext.close();
});

