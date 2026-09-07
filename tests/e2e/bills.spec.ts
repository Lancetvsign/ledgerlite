import { expect, test, type Page } from '@playwright/test';

import { BILLS_STORAGE } from './constants';

/**
 * A/P UI — LL-065 (bills, bill payments, A/P aging, vendor statement).
 *
 * A dedicated signed-in session; each test creates a fresh standard-chart company (so
 * A/P, an expense account, and a Checking account exist). Drives the whole A/P flow in
 * a real browser: add a vendor, raise a bill (create → finalize), pay it, confirm the
 * bill reads PAID, void the payment and confirm it returns to OPEN — the LL-061/062
 * lifecycle end to end. Then the reporting tie: the A/P aging grand total on screen
 * equals the A/P control in the trial balance (the LL-064 reconciliation, GL-T026), and
 * a vendor statement decomposes it. Money is asserted as the services' exact strings.
 */
test.use({ storageState: BILLS_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Bill Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await page.getByPlaceholder('New company legal name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click(); // chart defaults to standard
  await expect(page.getByTestId('company-list')).toContainText(name);
}

async function addVendor(page: Page, name: string): Promise<void> {
  await page.goto('/vendors');
  await page.getByTestId('vendor-name').fill(name);
  await page.getByTestId('add-vendor').click();
  await expect(page.getByTestId('vendors-table')).toContainText(name);
}

/** Create + finalize a bill against the standard chart's Office Supplies; returns its id (OPEN). */
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

/** Pay `amount` of the vendor's single open bill from Checking; returns the payment id (POSTED). */
async function payBill(page: Page, vendor: string, amount: string): Promise<string> {
  await page.goto('/bill-payments/new');
  await expect(page.getByTestId('bill-payment-form')).toBeVisible();
  await page.getByTestId('bill-payment-vendor').fill(vendor);
  await page.getByTestId('bill-payment-cash').fill('Checking');
  await expect(page.getByTestId('apply-row')).toHaveCount(1); // the vendor's one open bill
  await page.getByTestId('apply-amount-0').fill(amount);
  await page.getByTestId('save-bill-payment').click();
  await expect(page).toHaveURL(/\/bill-payments\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('bill-payment-status')).toHaveText('POSTED');
  return page.url().split('/').pop() ?? '';
}

test('create → finalize → pay a bill in full, then void the payment; the bill tracks PAID → OPEN', async ({ page }) => {
  await freshCompany(page);
  await addVendor(page, 'Globex Supply');
  const billId = await openBill(page, 'Globex Supply', '100.00');

  const paymentId = await payBill(page, 'Globex Supply', '100.00');
  await expect(page.getByTestId('bill-payment-amount')).toHaveText('100.0000');

  // The bill is now fully paid.
  await page.goto(`/bills/${billId}`);
  await expect(page.getByTestId('bill-status')).toHaveText('PAID');

  // Void the payment → it reverses, and the bill returns to OPEN.
  await page.goto(`/bill-payments/${paymentId}`);
  await page.getByTestId('void-bill-payment').click();
  await expect(page.getByTestId('bill-payment-status')).toHaveText('VOID');
  await page.goto(`/bills/${billId}`);
  await expect(page.getByTestId('bill-status')).toHaveText('OPEN');
});

test('the A/P aging grand total on screen equals the A/P control in the trial balance', async ({ page }) => {
  await freshCompany(page);
  await addVendor(page, 'Globex Supply');
  await openBill(page, 'Globex Supply', '100.00');
  await payBill(page, 'Globex Supply', '40.00'); // A/P net = 100 − 40 = 60

  // Reach reports via the account nav (proves the entry points exist).
  await page.goto('/account');
  await page.getByTestId('reports-link').click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByTestId('ap-aging-link')).toBeVisible();
  await expect(page.getByTestId('vendor-statement-link')).toBeVisible();

  // Trial balance: balanced, and the Accounts Payable control is 60.0000.
  await page.getByTestId('trial-balance-link').click();
  await expect(page).toHaveURL(/\/reports\/trial-balance$/);
  await expect(page.getByTestId('tb-balanced')).toContainText('Balanced');
  await expect(
    page.getByTestId('trial-balance-row').filter({ hasText: 'Accounts Payable' }),
  ).toContainText('60.0000');

  // A/P aging: the grand total equals that A/P control — the reconciliation on screen.
  await page.goto('/reports/ap-aging');
  await expect(page.getByTestId('ap-aging-total')).toHaveText('60.0000');
  await expect(page.getByTestId('ap-aging-row').filter({ hasText: 'Globex Supply' })).toContainText('60.0000');
});

test('a vendor statement shows opening, activity and closing', async ({ page }) => {
  await freshCompany(page);
  await addVendor(page, 'Beta Supply');
  await openBill(page, 'Beta Supply', '200.00');
  await payBill(page, 'Beta Supply', '50.00'); // closing = 200 − 50 = 150

  await page.goto('/reports/vendor-statement');
  await page.getByTestId('vendor-statement-vendor').selectOption({ label: 'Beta Supply' });
  // An explicit wide window: the bill is dated by the form's UTC "today" while the
  // report's default `to` is the COMPANY's today, and near midnight UTC those differ —
  // the bill would post "tomorrow" and drop out of the window. Fixed dates keep this
  // assertion time-of-day independent.
  await page.getByTestId('vendor-statement-from').fill('2000-01-01');
  await page.getByTestId('vendor-statement-to').fill('2099-12-31');
  await page.getByTestId('vendor-statement-submit').click();

  await expect(page.getByTestId('vendor-statement')).toBeVisible();
  await expect(page.getByTestId('vendor-statement-name')).toHaveText('Beta Supply');
  await expect(page.getByTestId('vendor-statement-opening')).toHaveText('0.0000');
  await expect(page.getByTestId('vendor-statement-row')).toHaveCount(2);
  await expect(page.getByTestId('vendor-statement-table')).toContainText('EXPENSE');
  await expect(page.getByTestId('vendor-statement-table')).toContainText('200.0000');
  await expect(page.getByTestId('vendor-statement-table')).toContainText('BILL_PAYMENT');
  await expect(page.getByTestId('vendor-statement-table')).toContainText('50.0000');
  await expect(page.getByTestId('vendor-statement-closing')).toHaveText('150.0000');
});

test('the bill-payment form only shows the selected vendor’s open bills', async ({ page }) => {
  await freshCompany(page);
  await addVendor(page, 'Globex Supply');
  await addVendor(page, 'Beta Supply');
  await openBill(page, 'Globex Supply', '100.00'); // Globex has one open bill; Beta has none

  await page.goto('/bill-payments/new');
  await page.getByTestId('bill-payment-vendor').fill('Beta Supply');
  await expect(page.getByTestId('apply-row')).toHaveCount(0); // Beta has no open bills
  await page.getByTestId('bill-payment-vendor').fill('Globex Supply');
  await expect(page.getByTestId('apply-row')).toHaveCount(1); // Globex's bill, not Beta's
});

test.describe('unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // fresh, signed-out session

  test('an unauthenticated visitor cannot reach the A/P pages', async ({ page }) => {
    for (const path of ['/bills', '/bill-payments', '/vendors', '/reports/ap-aging', '/reports/vendor-statement']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in/);
    }
  });
});

test('an invalid as-of date on the A/P aging is rejected', async ({ page }) => {
  await freshCompany(page);
  await page.goto('/reports/ap-aging?asOf=not-a-date');
  await expect(page.getByTestId('notice')).toBeVisible();
  await expect(page.getByTestId('ap-aging-table')).toHaveCount(0); // no results for a bad date
});
