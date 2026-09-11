import { expect, test as setup } from '@playwright/test';

import { RECONCILIATION_STORAGE, RECONCILIATION_USER } from './constants';

setup('authenticate reconciliation user', async ({ page, request }) => {
  await request
    .post('/api/auth/sign-up/email', {
      data: RECONCILIATION_USER,
      headers: { origin: 'http://127.0.0.1:3200' },
    })
    .catch(() => undefined); // already exists locally → fall through to sign-in
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(RECONCILIATION_USER.email);
  await page.getByLabel('Password').fill(RECONCILIATION_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account/);
  await page.context().storageState({ path: RECONCILIATION_STORAGE });
});
