import { defineConfig, devices } from '@playwright/test';

// Deliberately NOT the dev server's port. `reuseExistingServer` would otherwise
// latch onto a running dev server, silently testing a dev build — which emits
// HMR console errors and would fail the strict no-console-errors assertion for
// reasons that have nothing to do with the application.
const PORT = 3200;
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',

  // A test that only passes sometimes is worse than no test: it teaches people
  // to re-run rather than read. Retries are off locally so flakiness surfaces.
  retries: process.env['CI'] === undefined ? 0 : 1,
  forbidOnly: process.env['CI'] !== undefined,
  // Single worker: E2E shares one database and one Better Auth surface, and
  // parallel specs contend on session state (a sign-out in one spec racing a
  // sign-in in another). Serial is a few seconds slower and deterministic —
  // the right trade for an auth-heavy suite against shared state.
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Signs up/in through the app's own endpoints and saves storageState;
    // authenticated specs depend on it. See tests/e2e/auth.setup.ts.
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],

  // E2E runs against a PRODUCTION build, not the dev server.
  //
  // Two reasons. First, it exercises what actually ships — dev and production
  // differ in bundling, error handling, and rendering. Second, the dev server's
  // HMR WebSocket emits console errors of its own, and a suite that has to
  // filter infrastructure noise eventually filters a real error by accident.
  // Building takes a few seconds; assertions like "no console errors" become
  // meaningful in exchange.
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 180_000,
    env: {
      ...process.env,
      // The app under test needs auth configuration. Next.js loads .env.local
      // but does not override variables already in the environment, so these
      // take effect while a developer's own values still win locally.
      BETTER_AUTH_URL: BASE_URL,
      BETTER_AUTH_SECRET:
        process.env['BETTER_AUTH_SECRET'] ??
        'SYNTHETIC-E2E-ONLY-SECRET-0000000000000000000000000000',
      // The suite signs several users in back-to-back from one IP; Better Auth's
      // production rate limit would throttle the last one. Trusted test env only —
      // never set in production/preview, so prod keeps rate limiting. See src/lib/auth.
      E2E_RATE_LIMIT_DISABLED: 'true',
    },
  },
});
