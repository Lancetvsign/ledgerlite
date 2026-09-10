import { expect, test as setup } from '@playwright/test';

import { DASHBOARD_STORAGE, DASHBOARD_USER } from './constants';

setup('authenticate dashboard user', async ({ page, request }) => {
  await request
    .post('/api/auth/sign-up/email', {
      data: DASHBOARD_USER,
      headers: { origin: 'http://127.0.0.1:3200' },
    })
    .catch(() => undefined); // already exists locally → fall through to sign-in
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(DASHBOARD_USER.email);
  await page.getByLabel('Password').fill(DASHBOARD_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account/);
  await page.context().storageState({ path: DASHBOARD_STORAGE });
});
