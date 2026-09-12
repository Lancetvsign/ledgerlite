import { expect, test, type Page } from '@playwright/test';

import { REPORTS_STORAGE } from './constants';

/**
 * Reporting UI — LL-055.
 *
 * A dedicated signed-in session; each test builds a fresh standard-chart company
 * (so A/R, Sales Revenue and a deposit account exist) and drives the real screens.
 * The decisive assertion is reconciliation ON SCREEN: the A/R Aging grand total
 * equals the derived Accounts Receivable balance shown on the Trial Balance —
 * the subsidiary⇔control discipline (GL-T018), visible to a user. All money is
 * asserted as the service's exact NUMERIC(19,4) string; the UI never reformats it.
 */
test.use({ storageState: REPORTS_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Rpt Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

/** Create + finalize an invoice (status OPEN) for `price`. */
async function openInvoice(page: Page, customer: string, price: string): Promise<void> {
  await page.goto('/invoices/new');
  await page.getByTestId('invoice-customer').fill(customer);
  await page.getByTestId('line-account-0').fill('Sales Revenue');
  await page.getByTestId('line-qty-0').fill('1');
  await page.getByTestId('line-price-0').fill(price);
  await page.getByTestId('save-invoice').click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await page.getByTestId('finalize-invoice').click();
  await expect(page.getByTestId('invoice-status')).toHaveText('OPEN');
}

/** Receive a payment from `customer` applying `amount` to their one open invoice. */
async function receivePayment(page: Page, customer: string, amount: string): Promise<void> {
  await page.goto('/payments/new');
  await page.getByTestId('payment-customer').fill(customer);
  await page.getByTestId('payment-deposit').fill('Checking');
  await expect(page.getByTestId('apply-row')).toHaveCount(1);
  await page.getByTestId('apply-amount-0').fill(amount);
  await page.getByTestId('save-payment').click();
  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('payment-status')).toHaveText('POSTED');
}

test('trial balance is balanced and its A/R reconciles to the aging grand total', async ({ page }) => {
  await freshCompany(page);
  await addCustomer(page, 'Acme LLC');
  await openInvoice(page, 'Acme LLC', '100.00');
  await receivePayment(page, 'Acme LLC', '40.00'); // A/R net = 100 − 40 = 60

  // Reach reports via the account nav (proves the entry point exists).
  await page.goto('/account');
  await page.getByTestId('reports-link').click();
  await expect(page).toHaveURL(/\/reports$/);

  // Trial balance: balanced, and the Accounts Receivable balance is 60.0000.
  await page.getByTestId('trial-balance-link').click();
  await expect(page).toHaveURL(/\/reports\/trial-balance$/);
  await expect(page.getByTestId('tb-balanced')).toContainText('Balanced');
  await expect(
    page.getByTestId('trial-balance-row').filter({ hasText: 'Accounts Receivable' }),
  ).toContainText('60.00');

  // A/R aging: the grand total equals that A/R control — reconciliation on screen.
  await page.goto('/reports/aging');
  await expect(page.getByTestId('aging-total')).toHaveText('60.00');
  await expect(page.getByTestId('aging-row').filter({ hasText: 'Acme LLC' })).toContainText('60.00');
});

test('a customer statement shows opening, activity and closing', async ({ page }) => {
  await freshCompany(page);
  await addCustomer(page, 'Beta Co');
  await openInvoice(page, 'Beta Co', '200.00');
  await receivePayment(page, 'Beta Co', '50.00'); // closing = 200 − 50 = 150

  await page.goto('/reports/statement');
  await page.getByTestId('statement-customer').selectOption({ label: 'Beta Co' });
  await page.getByTestId('statement-submit').click();

  await expect(page.getByTestId('statement')).toBeVisible();
  await expect(page.getByTestId('statement-customer-name')).toHaveText('Beta Co');
  await expect(page.getByTestId('statement-opening')).toHaveText('0.00');
  await expect(page.getByTestId('statement-row')).toHaveCount(2);
  await expect(page.getByTestId('statement-table')).toContainText('INVOICE');
  await expect(page.getByTestId('statement-table')).toContainText('200.00');
  await expect(page.getByTestId('statement-table')).toContainText('CUSTOMER_PAYMENT');
  await expect(page.getByTestId('statement-table')).toContainText('50.00');
  await expect(page.getByTestId('statement-closing')).toHaveText('150.00');
});

test.describe('unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // fresh, signed-out session

  test('an unauthenticated visitor is redirected to sign-in', async ({ page }) => {
    await page.goto('/reports');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test('an invalid as-of date is rejected', async ({ page }) => {
  await freshCompany(page);
  await page.goto('/reports/trial-balance?asOf=not-a-date');
  await expect(page.getByTestId('notice')).toBeVisible();
  await expect(page.getByTestId('trial-balance-table')).toHaveCount(0); // no results for a bad date
});
