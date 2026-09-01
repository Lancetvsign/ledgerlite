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
