import { expect, test, type Page } from '@playwright/test';

import { PAYMENTS_STORAGE } from './constants';

/**
 * Payment UI — LL-045.
 *
 * A dedicated signed-in session; each test creates a fresh standard-chart company
 * (so A/R and an asset deposit account exist). Drives the whole flow in a real
 * browser: raise an invoice, receive a payment applying its full balance, confirm
 * the invoice reads PAID, then void the payment and confirm the invoice returns
 * to OPEN — the LL-043 lifecycle, end to end through the UI.
 */
test.use({ storageState: PAYMENTS_STORAGE });

async function freshCompany(page: Page): Promise<void> {
  await page.goto('/account');
  const name = `Pay Co ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

test('receive a payment then void it; the invoice tracks PAID → OPEN', async ({ page }) => {
  await freshCompany(page);
  await addCustomer(page, 'Acme LLC');
  const invoiceId = await openInvoice(page, 'Acme LLC', '100.00');

  // Receive a payment applying the invoice's full open balance.
  await page.goto('/payments/new');
  await expect(page.getByTestId('payment-form')).toBeVisible();
  await page.getByTestId('payment-customer').fill('Acme LLC');
  await page.getByTestId('payment-deposit').fill('Checking');
  await expect(page.getByTestId('apply-row')).toHaveCount(1); // the customer's one open invoice
  await page.getByTestId('apply-amount-0').fill('100.00');
  await expect(page.getByTestId('payment-total')).toHaveText('100.00');
  await page.getByTestId('save-payment').click();

  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
  const paymentId = page.url().split('/').pop() ?? '';
  await expect(page.getByTestId('payment-status')).toHaveText('POSTED');
  await expect(page.getByTestId('payment-amount')).toHaveText('100.0000');

  // The invoice is now fully paid.
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByTestId('invoice-status')).toHaveText('PAID');

  // Void the payment → it reverses, and the invoice returns to OPEN.
  await page.goto(`/payments/${paymentId}`);
  await page.getByTestId('void-payment').click();
  await expect(page.getByTestId('payment-status')).toHaveText('VOID');
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByTestId('invoice-status')).toHaveText('OPEN');
});

test('the payment form only shows the selected customer’s open invoices', async ({ page }) => {
  await freshCompany(page);
  await addCustomer(page, 'Acme LLC');
  await addCustomer(page, 'Beta Co');
  await openInvoice(page, 'Acme LLC', '100.00'); // Acme has one open invoice; Beta has none

  await page.goto('/payments/new');
  await page.getByTestId('payment-customer').fill('Beta Co');
  await expect(page.getByTestId('apply-row')).toHaveCount(0); // Beta has no open invoices
  await page.getByTestId('payment-customer').fill('Acme LLC');
  await expect(page.getByTestId('apply-row')).toHaveCount(1); // Acme's invoice, not Beta's
});
