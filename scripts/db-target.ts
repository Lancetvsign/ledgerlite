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

import { describeConnection, endpointIdFromConnectionString } from '../src/db/env';
import { assertNotProductionByConfig, UnsafeDatabaseError } from '../src/db/safety';

config({ path: '.env.local', quiet: true });

const url = process.env['DATABASE_URL'];

if (url === undefined || url.trim() === '') {
  // Listing the names that ARE present turns "not set" into a diagnosis. The
  // Vercel/Neon integration provisions Preview and Production but often leaves
  // Development empty, so `vercel env pull --environment=development` succeeds
  // and yields nothing — a silent no-op that looks like a broken script.
  const interesting = Object.keys(process.env)
    .filter((k) => /^(DATABASE|POSTGRES|PG|NEON|VERCEL|APP_ENV|TEST_DATABASE)/.test(k))
    .sort();

  console.error('DATABASE_URL is not set.\n');
  console.error(
    interesting.length > 0
      ? `Related variables that ARE set (names only):\n  ${interesting.join('\n  ')}\n`
      : 'No database-related variables are set at all.\n',
  );
  console.error('If you provisioned Neon through Vercel, check which environments got');
  console.error('variables:  vercel env ls');
  console.error('');
  console.error('That integration commonly populates Preview and Production but NOT');
  console.error('Development, so pulling development is a silent no-op. Do NOT pull');
  console.error('production as a workaround — create a Neon development branch and put');
  console.error('its connection string in .env.local. See docs/TESTING.md.');
  process.exit(1);
}

const target = describeConnection(url);
let host = '(unparseable)';
try {
  host = new URL(url).hostname;
} catch {
  /* keep the placeholder; describeConnection already reported what it could */
}

const suggested = endpointIdFromConnectionString(url);

const unpooled = process.env['DATABASE_URL_UNPOOLED'];
const directHost = (() => {
  if (unpooled === undefined || unpooled.trim() === '') return undefined;
  try {
    return new URL(unpooled).hostname;
  } catch {
    return '(unparseable)';
  }
})();

console.info(`Target        ${target}`);
console.info(`Host          ${host}`);
console.info(
  `Direct host   ${directHost ?? 'DATABASE_URL_UNPOOLED not set — migrations will refuse to run'}`,
);

// Both hostnames must name the SAME branch. A mismatched pair means the
// application and the migration runner would operate on different databases,
// which no later check would catch.
if (directHost !== undefined && directHost !== '(unparseable)') {
  const sameBranch = host.replace('-pooler', '') === directHost;
  console.info(`Same branch   ${sameBranch ? 'yes' : 'NO — pooled and direct name DIFFERENT branches'}`);
}
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
