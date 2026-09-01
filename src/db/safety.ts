/**
 * Destructive-operation safety guard.
 *
 * Integration tests truncate tables. `db:verify` drops them. Both are correct
 * against a development branch and catastrophic against production, and the
 * difference between the two is one environment variable a tired person can get
 * wrong at 11pm.
 *
 * So the guard FAILS CLOSED at three independent layers, and every layer must
 * pass before a single destructive statement runs:
 *
 *   1. APP_ENV must be exactly "test"          — explicit opt-in, never a default
 *   2. the connection target must not look like production, and must appear in
 *      an explicit allowlist                    — no allowlist means no run
 *   3. the database must identify ITSELF as non-production, by carrying a marker
 *      table that only a deliberate human command creates
 *
 * Layer 3 is the one that actually holds. Layers 1 and 2 reason about a string
 * someone typed; layer 3 asks the database. Production will never carry the
 * marker, because nobody ever ran `npm run db:mark-test` against it — and if
 * someone did, that is a deliberate act, not an accident.
 *
 * A Neon connection string does NOT contain the branch name (the host is an
 * opaque endpoint id like ep-cool-fire-123), so string inspection alone can
 * never be sufficient. That is precisely why layer 3 exists.
 */
import { describeConnection } from './env';

/** Table whose presence marks a database as safe to destroy. Never in a migration. */
export const TEST_MARKER_TABLE = '_ledgerlite_test_marker';

const PRODUCTION_MARKERS = ['prod', 'production', 'live', 'master'] as const;

export class UnsafeDatabaseError extends Error {
  public override readonly name = 'UnsafeDatabaseError';
}

function fail(reason: string, remedy: string): never {
  throw new UnsafeDatabaseError(
    `Refusing to run a destructive database operation.\n\n${reason}\n\n${remedy}`,
  );
}

export interface GuardEnvironment {
  readonly connectionString: string;
  readonly appEnv: string | undefined;
  /** Comma-separated host substrings, from TEST_DATABASE_ALLOWLIST. */
  readonly allowlist: string | undefined;
}

/**
 * Layers 1 and 2. Pure — no connection, no I/O, fully unit testable.
 */
export function assertNotProductionByConfig(env: GuardEnvironment): void {
  const target = describeConnection(env.connectionString);

  // --- Layer 1: explicit opt-in -------------------------------------------
  if (env.appEnv !== 'test') {
    fail(
      `APP_ENV is ${env.appEnv === undefined ? 'not set' : `"${env.appEnv}"`}, not "test".`,
      'Destructive database work requires APP_ENV=test. This is deliberate: it must ' +
        'never be the default, so that running a test command in the wrong shell does ' +
        'nothing rather than something irreversible.',
    );
  }

  // --- Layer 2a: denylist --------------------------------------------------
  const lowered = target.toLowerCase();
  const matched = PRODUCTION_MARKERS.find((marker) =>
    new RegExp(`(^|[^a-z])${marker}([^a-z]|$)`).test(lowered),
  );

  if (matched !== undefined) {
    fail(
      `The connection target ${target} contains "${matched}", which looks like production.`,
      'Point DATABASE_URL at your own development branch. If this is a false positive ' +
        'on a legitimately named development database, rename the database rather than ' +
        'weakening this guard.',
    );
  }

  // --- Layer 2b: allowlist -------------------------------------------------
  const entries = (env.allowlist ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    fail(
      'TEST_DATABASE_ALLOWLIST is not set, so no database is approved for destructive use.',
      'Set TEST_DATABASE_ALLOWLIST in .env.local to a comma-separated list of host ' +
        'substrings you have deliberately approved, for example the endpoint id of your ' +
        'own Neon development branch. An empty allowlist approves nothing, by design.',
    );
  }

  if (!entries.some((entry) => lowered.includes(entry))) {
    fail(
      `The connection target ${target} is not in TEST_DATABASE_ALLOWLIST.`,
      'Add its host to the allowlist only if you are certain it is a development or ' +
        'test branch whose data can be destroyed.',
    );
  }
}

/**
 * Layer 3: ask the database what it is.
 *
 * `probe` returns whether the marker table exists. Injected rather than taken as
 * a client so this is unit testable without a database.
 */
export async function assertTestDatabaseMarker(
  probe: () => Promise<boolean>,
  connectionString: string,
): Promise<void> {
  const target = describeConnection(connectionString);
  let present: boolean;

  try {
    present = await probe();
  } catch (error) {
    // An unreadable answer is not a yes. Fail closed.
    fail(
      `Could not confirm that ${target} is a test database: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      'The guard fails closed. Fix the connection before retrying; do not bypass this.',
    );
  }

  if (!present) {
    fail(
      `${target} does not carry the "${TEST_MARKER_TABLE}" table, so it has not been ` +
        'marked as a test database.',
      `Run 'npm run db:mark-test' against that database if — and only if — its data is ` +
        'disposable. Never run it against production.',
    );
  }
}

/** Both layers. What every destructive entry point calls. */
export async function assertSafeForDestructiveUse(
  env: GuardEnvironment,
  probe: () => Promise<boolean>,
): Promise<void> {
  assertNotProductionByConfig(env);
  await assertTestDatabaseMarker(probe, env.connectionString);
}
