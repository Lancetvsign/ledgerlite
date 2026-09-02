/** Shared between auth.setup.ts and specs — Playwright forbids importing one test file from another. */
export const STORAGE_STATE = 'tests/e2e/.auth/user.json';
export const E2E_EMAIL = 'e2e-user@synthetic.test';
export const E2E_PASSWORD = 'synthetic-password-1';

/** LL-024 chart-of-accounts specs — a dedicated session, isolated from the shared user. */
export const ACCOUNTS_STORAGE = 'tests/e2e/.auth/accounts.json';
export const ACCOUNTS_USER = {
  email: 'e2e-accounts@synthetic.test',
  password: 'synthetic-password-1',
  name: 'Accounts Tester',
};
