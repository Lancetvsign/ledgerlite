/**
 * Prints which database DATABASE_URL points at, with credentials stripped, and
 * the exact TEST_DATABASE_ALLOWLIST entry that would approve it.
 *
 * "Which database am I actually pointed at?" is the question whose wrong answer
 * is most expensive in this project, and it is worth being able to ask cheaply —
 * before running migrations, after switching branches, when a test does something
 * surprising.
 *
 * Prints only redacted output. Safe to paste into an issue or a chat.
 *
 * Usage:  npm run db:target
 */
import { config } from 'dotenv';

import { describeConnection } from '../src/db/env';
import { assertNotProductionByConfig, UnsafeDatabaseError } from '../src/db/safety';

config({ path: '.env.local', quiet: true });

const url = process.env['DATABASE_URL'];

if (url === undefined || url.trim() === '') {
  console.error('DATABASE_URL is not set. Create .env.local from .env.example first.');
  process.exit(1);
}

const target = describeConnection(url);
let host = '(unparseable)';
try {
  host = new URL(url).hostname;
} catch {
  /* keep the placeholder; describeConnection already reported what it could */
}

// The endpoint id is the leading label of a Neon hostname and is the part that
// identifies the branch, so it is the right granularity for the allowlist:
// specific enough not to approve a sibling branch, stable across restarts.
const suggested = host.split('.')[0] ?? host;

console.info(`Target        ${target}`);
console.info(`Host          ${host}`);
console.info(`APP_ENV       ${process.env['APP_ENV'] ?? '(not set)'}`);
console.info(`Allowlist     ${process.env['TEST_DATABASE_ALLOWLIST'] ?? '(not set)'}`);
console.info('');

try {
  assertNotProductionByConfig({
    connectionString: url,
    appEnv: process.env['APP_ENV'],
    allowlist: process.env['TEST_DATABASE_ALLOWLIST'],
  });
  console.info('Guard layers 1 and 2: PASS — this database is approved for destructive use.');
  console.info('Layer 3 (marker table) is checked when a destructive command actually runs.');
} catch (error) {
  if (!(error instanceof UnsafeDatabaseError)) throw error;
  console.info('Guard layers 1 and 2: BLOCKED');
  console.info('');
  console.info(error.message);
  console.info('');
  console.info('If this is your own disposable development branch, add to .env.local:');
  console.info('');
  console.info(`  APP_ENV=test`);
  console.info(`  TEST_DATABASE_ALLOWLIST=${suggested}`);
}
