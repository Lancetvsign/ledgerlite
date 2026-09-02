import { expect, test as setup } from '@playwright/test';

import { E2E_EMAIL as EMAIL, E2E_PASSWORD as PASSWORD, STORAGE_STATE } from './constants';

/**
 * Prepares authenticated browser state ONCE; authed specs reuse it via
 * `test.use({ storageState })`. Logging in per test is the usual reason an E2E
 * suite becomes too slow to run — and then stops being run.
 *
 * The account is created through the application's own sign-up endpoint, never
 * by writing auth tables directly — that would prove a state the application
 * cannot actually produce. Locally the user persists between runs, so an
 * "already exists" answer falls through to sign-in.
 */
setup('authenticate', async ({ request }) => {
  const signUp = await request.post('/api/auth/sign-up/email', {
    data: { email: EMAIL, password: PASSWORD, name: 'E2E User' },
  });

  if (!signUp.ok()) {
    const signIn = await request.post('/api/auth/sign-in/email', {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(signIn.ok(), 'neither sign-up nor sign-in succeeded').toBe(true);
  }

  await request.storageState({ path: STORAGE_STATE });
});
