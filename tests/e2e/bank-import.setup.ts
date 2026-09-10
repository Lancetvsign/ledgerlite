import { expect, test as setup } from '@playwright/test';

import { BANK_IMPORT_STORAGE, BANK_IMPORT_USER } from './constants';

setup('authenticate bank-import user', async ({ page, request }) => {
  await request
    .post('/api/auth/sign-up/email', {
      data: BANK_IMPORT_USER,
      headers: { origin: 'http://127.0.0.1:3200' },
    })
    .catch(() => undefined); // already exists locally → fall through to sign-in
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(BANK_IMPORT_USER.email);
  await page.getByLabel('Password').fill(BANK_IMPORT_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account/);
  await page.context().storageState({ path: BANK_IMPORT_STORAGE });
});
