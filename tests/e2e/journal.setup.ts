import { expect, test as setup } from '@playwright/test';

import { JOURNAL_STORAGE, JOURNAL_USER } from './constants';

setup('authenticate journal user', async ({ page, request }) => {
  await request
    .post('/api/auth/sign-up/email', {
      data: JOURNAL_USER,
      headers: { origin: 'http://127.0.0.1:3200' },
    })
    .catch(() => undefined); // already exists locally → fall through to sign-in
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(JOURNAL_USER.email);
  await page.getByLabel('Password').fill(JOURNAL_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account/);
  await page.context().storageState({ path: JOURNAL_STORAGE });
});
