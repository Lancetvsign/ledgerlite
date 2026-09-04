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

/** LL-035 manual journal-entry specs — its own session, isolated from the others. */
export const JOURNAL_STORAGE = 'tests/e2e/.auth/journal.json';
export const JOURNAL_USER = {
  email: 'e2e-journal@synthetic.test',
  password: 'synthetic-password-1',
  name: 'Journal Tester',
};

/** LL-044 invoice-UI specs — its own session, isolated from the others. */
export const INVOICES_STORAGE = 'tests/e2e/.auth/invoices.json';
export const INVOICES_USER = {
  email: 'e2e-invoices@synthetic.test',
  password: 'synthetic-password-1',
  name: 'Invoices Tester',
};

/** LL-045 payment-UI specs — its own session, isolated from the others. */
export const PAYMENTS_STORAGE = 'tests/e2e/.auth/payments.json';
export const PAYMENTS_USER = {
  email: 'e2e-payments@synthetic.test',
  password: 'synthetic-password-1',
  name: 'Payments Tester',
};
