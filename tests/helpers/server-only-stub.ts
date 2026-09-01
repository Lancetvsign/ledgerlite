/**
 * Stand-in for the `server-only` package under Vitest.
 *
 * The real package throws when imported outside a React Server Component, which
 * is exactly what makes it valuable in the app and useless in a Node test runner.
 * Aliasing it here lets tests import server modules directly.
 *
 * This does NOT weaken the guarantee: the protection is enforced at BUILD time by
 * Next, and LL-002 verified that a Client Component importing `@/db` fails the
 * build. This alias affects the test runner only.
 */
export {};
