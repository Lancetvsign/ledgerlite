/**
 * Runs before every integration test file.
 *
 * Its job is to make it impossible to reach a destructive statement without the
 * safety guard having passed. If configuration is missing or the target is not a
 * marked test database, the suite aborts here with an actionable message rather
 * than failing obscurely partway through.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll } from 'vitest';

import { closeTestDb, getTestDb, truncateAll } from './database';

config({ path: '.env.local', quiet: true });

beforeAll(async () => {
  if (process.env['DATABASE_URL'] === undefined || process.env['DATABASE_URL'].trim() === '') {
    throw new Error(
      'Integration tests require DATABASE_URL.\n\n' +
        'Set it in .env.local to YOUR OWN Neon development branch, then:\n' +
        '  APP_ENV=test npm run db:mark-test\n' +
        '  npm run test:integration\n\n' +
        'See docs/TESTING.md.',
    );
  }

  // Runs the three-layer guard. Throws if this database is not marked as a test
  // database — see src/db/safety.ts.
  await getTestDb();
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});
