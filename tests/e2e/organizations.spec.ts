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
