/**
 * Playwright global setup.
 *
 * PURPOSE: prepare authenticated browser state ONCE and reuse it across specs,
 * rather than logging in per test. Logging in per test is the usual reason an
 * E2E suite becomes too slow to run, and then stops being run.
 *
 * Authentication does not exist yet — Better Auth arrives in LL-010. The seam is
 * built now so that adding it is a small edit here rather than a restructure of
 * every spec.
 *
 * TODO(LL-010): replace the placeholder below with:
 *   1. seed a known test user via the application's own signup path
 *      (never by writing auth tables directly — that would test a state the
 *       application cannot actually produce)
 *   2. log in through the real login form in a browser context
 *   3. context.storageState({ path: STORAGE_STATE }) to persist cookies
 * Specs then opt in with `test.use({ storageState: STORAGE_STATE })`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STORAGE_STATE = 'tests/e2e/.auth/user.json';

export default async function globalSetup(): Promise<void> {
  // An empty but valid storage state. Specs that need authentication are written
  // from LL-010 onward; until then this exists only so the seam is real and the
  // file path is already agreed.
  await mkdir(dirname(STORAGE_STATE), { recursive: true });
  await writeFile(STORAGE_STATE, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
}
