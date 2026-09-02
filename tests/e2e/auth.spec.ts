import { expect, test } from '@playwright/test';

import { E2E_EMAIL as EMAIL, E2E_PASSWORD as PASSWORD, STORAGE_STATE } from './constants';

test.describe('unauthenticated', () => {
  test('the protected route redirects to sign-in', async ({ page }) => {
    await page.goto('/account');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('the landing page stays public', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'LedgerLite' })).toBeVisible();
  });
});

test.describe('authenticated', () => {
  test.use({ storageState: STORAGE_STATE });

  test('the protected route shows the signed-in user', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByTestId('account-email')).toHaveText(EMAIL);
  });

});

test.describe('sign-in form', () => {
  test('sign-out revokes access, not just the view', async ({ page }) => {
    // Signs in FRESH rather than using the shared storageState: this test
    // revokes its session server-side, and revoking the SHARED one made every
    // authenticated spec scheduled after it flake to /sign-in. A destructive
    // test brings its own state.
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account/);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/');

    // The part that matters: the old session must be dead, so the protected
    // route redirects rather than rendering from any remnant state.
    await page.goto('/account');
    await expect(page).toHaveURL(/\/sign-in/);
  });


  test('signs in through the real UI', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account/);
    await expect(page.getByTestId('account-email')).toHaveText(EMAIL);
  });

  test('rejects a wrong password without navigating', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill('wrong-password-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('auth-error')).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
