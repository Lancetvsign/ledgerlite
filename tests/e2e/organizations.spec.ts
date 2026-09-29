import { expect, test } from '@playwright/test';

import { STORAGE_STATE } from './constants';

test.use({ storageState: STORAGE_STATE });

/**
 * Organizations — LL-096. The owner groups two companies: create from one row, add the
 * other from its row, remove it again. Every step is a server action that re-proves OWNER.
 */
test('create an organization, add a second company, remove it', async ({ page }) => {
  const stamp = Date.now();
  const alpha = `Alpha Org Co ${stamp}`;
  const beta = `Beta Org Co ${stamp}`;
  const orgName = `Group ${stamp}`;
  await page.goto('/account');
  for (const name of [alpha, beta]) {
    await page.getByPlaceholder('New company legal name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('company-list')).toContainText(name, { timeout: 15_000 });
  }

  const alphaRow = page.locator('li', { hasText: alpha });
  await alphaRow.getByTestId('organization-menu').click();
  await alphaRow.getByPlaceholder('Organization name').fill(orgName);
  await alphaRow.getByTestId('create-organization').click();
  await expect(page.getByTestId('notice')).toContainText('Organization created');
  await expect(alphaRow.getByTestId('organization-badge')).toContainText(orgName);

  const betaRow = page.locator('li', { hasText: beta });
  await betaRow.getByTestId('organization-menu').click();
  await betaRow.getByTestId('organization-select').selectOption({ label: orgName });
  await betaRow.getByTestId('add-to-organization').click();
  await expect(page.getByTestId('notice')).toContainText('joined the organization');
  await expect(betaRow.getByTestId('organization-badge')).toContainText(orgName);
  await expect(page.locator('li', { hasText: alpha }).getByTestId('organization-badge')).toContainText(orgName);

  await betaRow.getByTestId('leave-organization').click();
  await expect(page.getByTestId('notice')).toContainText('left the organization');
  await expect(page.locator('li', { hasText: beta }).getByTestId('organization-badge')).toHaveCount(0);
  await expect(page.locator('li', { hasText: alpha }).getByTestId('organization-badge')).toContainText(orgName);

  // A member cannot be deleted until it leaves.
  const alphaAgain = page.locator('li', { hasText: alpha });
  await alphaAgain.locator('summary', { hasText: 'Delete' }).click();
  await alphaAgain.getByPlaceholder('Type the company name to confirm').fill(alpha);
  await alphaAgain.getByTestId('delete-company-confirm').click();
  await expect(page.getByTestId('notice')).toContainText('Remove the company from its organization');
  await expect(page.getByTestId('company-list')).toContainText(alpha);
});

/**
 * Consolidated statements — LL-122 (ADR-047). Two companies in one organization; the one you are in
 * posts a sale; the consolidated worksheet shows both companies side by side and balances.
 */
test('the consolidated statements show every member side by side and balance', async ({ page }) => {
  const stamp = Date.now();
  const alpha = `Alpha Cons Co ${stamp}`;
  const beta = `Beta Cons Co ${stamp}`;
  const orgName = `Cons Group ${stamp}`;
  await page.goto('/account');
  for (const name of [alpha, beta]) {
    await page.getByPlaceholder('New company legal name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('company-list')).toContainText(name, { timeout: 15_000 });
  }
  // Beta, created last, is the active company. Alpha opens the organization; Beta joins it.
  const alphaRow = page.locator('li', { hasText: alpha });
  await alphaRow.getByTestId('organization-menu').click();
  await alphaRow.getByPlaceholder('Organization name').fill(orgName);
  await alphaRow.getByTestId('create-organization').click();
  await expect(page.getByTestId('notice')).toContainText('Organization created');
  const betaRow = page.locator('li', { hasText: beta });
  await betaRow.getByTestId('organization-menu').click();
  await betaRow.getByTestId('organization-select').selectOption({ label: orgName });
  await betaRow.getByTestId('add-to-organization').click();
  await expect(page.getByTestId('notice')).toContainText('joined the organization');

  // Beta sells 100 for cash.
  await page.goto('/journal/new');
  await page.getByLabel('Reference / description').fill('Cash sale');
  await page.getByTestId('line-account-0').fill('Checking');
  await page.getByTestId('line-debit-0').fill('100.00');
  await page.getByTestId('line-account-1').fill('Sales Revenue');
  await page.getByTestId('line-credit-1').fill('100.00');
  await page.getByTestId('post-entry').click();
  await expect(page).toHaveURL(/\/journal\/[0-9a-f-]{36}$/, { timeout: 15_000 });

  await page.goto('/reports');
  await page.getByTestId('consolidated-balance-sheet-link').click();
  await expect(page.getByTestId('consolidated-company-column')).toHaveText([beta, alpha]); // the active company first
  await expect(page.getByTestId('consolidated-balanced')).toHaveText('Balanced');
  await expect(page.getByTestId('cbs-assets-total')).toHaveText('100.00');
  await expect(page.getByTestId('cbs-liabilities-and-equity-total')).toHaveText('100.00');
  await expect(page.getByTestId('consolidated-intercompany-state')).toHaveCount(0); // nothing intercompany

  await page.goto('/reports/consolidated-income-statement');
  await expect(page.getByTestId('consolidated-company-column')).toHaveText([beta, alpha]);
  await expect(page.getByTestId('cis-net-income')).toHaveText('100.00');

  // LL-125: the consolidated cash flow — the sale's cash, reconciled to the group's cash.
  await page.goto('/reports');
  await page.getByTestId('consolidated-cash-flow-link').click();
  await expect(page.getByTestId('consolidated-company-column')).toHaveText([beta, alpha]);
  await expect(page.getByTestId('consolidated-reconciled')).toHaveText('Reconciled to cash');
  await expect(page.getByTestId('ccf-net-change')).toHaveText('100.00');
  await expect(page.getByTestId('ccf-ending-cash')).toHaveText('100.00');
});
