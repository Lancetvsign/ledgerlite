/**
 * Runs before every integration test file.
 *
 * Its job is to make it impossible to reach a destructive statement without the
 * safety guard having passed. If configuration is missing or the target is not a
 * marked test database, the suite aborts here with an actionable message rather
 * than failing obscurely partway through.
 */
import { config } from 'dotenv';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { assertLedgerIntegrity } from '@/server/ledger/invariants';

import { closeTestDb, getTestDb, truncateAll } from './database';

config({ path: '.env.local', quiet: true });

// Auth flows need a secret. A synthetic one is set for tests when the developer
// has not configured their own — clearly marked so it can never be mistaken for
// a real credential, and long enough to satisfy Better Auth.
process.env['BETTER_AUTH_SECRET'] ??=
  'SYNTHETIC-TEST-ONLY-SECRET-0000000000000000000000000000';

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

// LL-034: after EVERY integration test, audit every company's ledger. Any test
// that corrupts the ledger — even one written to check something unrelated —
// fails here, turning the whole suite into a continuous integrity check. Tests
// that inject corruption deliberately must roll it back (the corruption suite
// does, via transactional DDL) so this teardown sees an intact ledger.
afterEach(async () => {
  await assertLedgerIntegrity();
});

afterAll(async () => {
  await closeTestDb();
});
