/**
 * Database environment access.
 *
 * Nothing here ever includes a credential in an error, a log line, or a thrown
 * message. A connection string contains a password; treating it as printable is
 * how it ends up in a CI log or an error-tracking service.
 */

const CREDENTIAL_PATTERN = /^(?<scheme>[a-z+]+:\/\/)(?<user>[^:@/]+)(?::[^@/]*)?@/i;

/**
 * Reduce a connection string to something safe to print: scheme, user, host and
 * database only. The password is removed, never masked in place — a masked
 * password still reveals its length.
 */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const user = url.username ? `${url.username}@` : '';
    return `${url.protocol}//${user}${url.host}${url.pathname}`;
  } catch {
    // Malformed URL: fall back to a pattern strip rather than returning the raw value.
    return connectionString.replace(CREDENTIAL_PATTERN, '$<scheme>$<user>@').split('?')[0] ?? '(unparseable)';
  }
}

/**
 * Read DATABASE_URL, failing immediately and legibly when it is absent.
 *
 * The failure is deliberately loud. A database module that silently falls back to
 * a default connection is how a test suite ends up pointed at the wrong database.
 */
export function getDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];

  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set.\n\n' +
        'Copy .env.example to .env.local and set DATABASE_URL to YOUR OWN Neon\n' +
        'development branch (for example dev/lance). Never point local development,\n' +
        'tests, or Preview at the production branch.\n\n' +
        'See docs/DATABASE.md.',
    );
  }

  return url;
}

/**
 * Connection string for work that needs a real, stable PostgreSQL session:
 * migrations, advisory locks, anything using session-level state.
 *
 * WHY THIS EXISTS. Neon's pooled endpoint (hostname contains `-pooler`) is
 * PgBouncer in TRANSACTION pooling mode. A client "session" there is not pinned
 * to one server backend — between statements the backend can be handed to
 * someone else. Session-level state does not survive that, and
 * `pg_advisory_lock()` is session-level.
 *
 * So a migration runner on the pooled endpoint can acquire its lock on one
 * backend, run migrations on another, and release on a third. It does not fail
 * loudly; it just stops protecting anything, which is the worst way for a lock
 * to be wrong.
 *
 * Prefers DATABASE_URL_UNPOOLED (the name Neon and Vercel both use), falling
 * back to DATABASE_URL only when it is already a direct endpoint.
 */
export function getDirectDatabaseUrl(): string {
  const unpooled = process.env['DATABASE_URL_UNPOOLED'];
  if (unpooled !== undefined && unpooled.trim() !== '') return unpooled;

  const fallback = getDatabaseUrl();

  if (isPooledEndpoint(fallback)) {
    throw new Error(
      'This operation needs a direct (unpooled) connection, but DATABASE_URL points at\n' +
        `a pooled endpoint:\n\n  ${describeConnection(fallback)}\n\n` +
        'Neon pooled endpoints run PgBouncer in transaction pooling mode, where\n' +
        'session-level advisory locks silently stop protecting anything.\n\n' +
        'Set DATABASE_URL_UNPOOLED in .env.local to the same branch WITHOUT "-pooler"\n' +
        'in the hostname. See docs/DATABASE.md.',
    );
  }

  return fallback;
}

/** True when the host is a Neon connection-pooler endpoint. */
export function isPooledEndpoint(connectionString: string): boolean {
  try {
    return new URL(connectionString).hostname.includes('-pooler');
  } catch {
    return /-pooler/.test(connectionString);
  }
}

/**
 * The Neon endpoint id for a connection string — the leading hostname label with
 * any `-pooler` suffix removed.
 *
 * This is the correct granularity for TEST_DATABASE_ALLOWLIST because ONE branch
 * has TWO hostnames: pooled (`ep-foo-pooler.…`) for the application and direct
 * (`ep-foo.…`) for migrations. The stripped id is a substring of both, so a
 * single allowlist entry approves the branch rather than one of its endpoints.
 *
 * Keeping the suffix was a real bug: the entry matched the app's connection and
 * not the migration runner's, so setup looked complete and `db:migrate` failed
 * later for reasons that pointed nowhere near the allowlist.
 */
export function endpointIdFromConnectionString(connectionString: string): string {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    host = connectionString;
  }
  return (host.split('.')[0] ?? host).replace(/-pooler$/, '');
}
