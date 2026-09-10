import { expect, test, type Page } from '@playwright/test';

import { DASHBOARD_STORAGE } from './constants';

/**
 * Dashboard UI — LL-075. A dedicated signed-in session builds a fresh standard-chart
 * company with a little activity, then opens the dashboard from /account and asserts the
 * headline stats show the exact NUMERIC(19,4) strings the services derive (the UI never
 * reformats money) and that recent activity appears.
 */
test.use({ storageState: DASHBOARD_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Dash Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

test('dashboard shows the headline stats and recent activity', async ({ page }) => {
  await freshCompany(page);
  await addCustomer(page, 'Acme');
  await openInvoice(page, 'Acme', '500.00'); // Dr A/R 500 / Cr Sales 500
  await receivePayment(page, 'Acme', '200.00'); // Dr Checking 200 / Cr A/R 200

  // Reach the dashboard the way a user does: from the company hub.
  await page.goto('/account');
  await page.getByTestId('dashboard-link').click();
  await expect(page).toHaveURL(/\/dashboard/);

  await expect(page.getByTestId('dashboard-cash')).toHaveText('200.0000'); // Checking (CASH)
  await expect(page.getByTestId('dashboard-ar')).toHaveText('300.0000'); // 500 invoiced − 200 paid
  await expect(page.getByTestId('dashboard-net-income')).toHaveText('500.0000'); // revenue, no expense

  // Recent activity lists the postings (the finalized invoice and the payment).
  await expect(page.getByTestId('dashboard-recent-row').first()).toBeVisible();
  await expect(page.getByTestId('dashboard-recent-row')).toHaveCount(2);
});

test.describe('unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the dashboard redirects to sign-in', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
