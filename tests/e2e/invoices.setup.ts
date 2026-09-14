import { expect, test as setup } from '@playwright/test';

import { deleteOwnedCompanies } from './company-cleanup';
import { INVOICES_STORAGE, INVOICES_USER } from './constants';

setup('authenticate invoices user', async ({ page, request }) => {
  await request
    .post('/api/auth/sign-up/email', {
      data: INVOICES_USER,
      headers: { origin: 'http://127.0.0.1:3200' },
    })
    .catch(() => undefined); // already exists locally → fall through to sign-in
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(INVOICES_USER.email);
  await page.getByLabel('Password').fill(INVOICES_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account/);
  await deleteOwnedCompanies(page); // older runs' companies would otherwise pile up on this user
  await page.context().storageState({ path: INVOICES_STORAGE });
});
