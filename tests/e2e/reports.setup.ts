import { expect, test as setup } from '@playwright/test';

import { REPORTS_STORAGE, REPORTS_USER } from './constants';

setup('authenticate reports user', async ({ page, request }) => {
  await request
    .post('/api/auth/sign-up/email', {
      data: REPORTS_USER,
      headers: { origin: 'http://127.0.0.1:3200' },
    })
    .catch(() => undefined); // already exists locally → fall through to sign-in
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(REPORTS_USER.email);
  await page.getByLabel('Password').fill(REPORTS_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account/);
  await page.context().storageState({ path: REPORTS_STORAGE });
});
