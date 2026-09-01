import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Authentication state is prepared once and reused. See tests/e2e/auth.setup.ts.
  globalSetup: './tests/e2e/global-setup.ts',

  // A test that only passes sometimes is worse than no test: it teaches people
  // to re-run rather than read. Retries are off locally so flakiness surfaces.
  retries: process.env['CI'] === undefined ? 0 : 1,
  forbidOnly: process.env['CI'] !== undefined,
  fullyParallel: true,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
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
  },
});
