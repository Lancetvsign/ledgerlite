import 'server-only';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { getDbTx, schema } from '@/db';

import { resolveBaseUrl, resolveTrustedOrigins } from './origins';

/**
 * Better Auth instance.
 *
 * Authentication ONLY. Being signed in grants access to nothing — company
 * membership and capabilities are separate application concerns (LL-013), and
 * no code may treat "has a session" as "may see data".
 *
 * Password hashing and session management are Better Auth's. We add none of our
 * own (AGENTS.md: no hand-rolled crypto).
 *
 * Lazy and memoized for the same reason as src/db: importing must never throw,
 * so `next build` and `npm run ci` succeed with no environment configured.
 * Only USE without configuration should fail — loudly, below.
 */

function requireSecret(): string {
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (secret === undefined || secret.trim() === '') {
    throw new Error(
      'BETTER_AUTH_SECRET is not set.\n\n' +
        'Generate one (at least 32 random bytes):\n\n' +
        '  openssl rand -base64 32\n\n' +
        'Set it in .env.local for development.每 environment gets its OWN secret —\n' +
        'sharing one across environments would make a session minted in Preview\n' +
        'valid in Production. See docs/DEPLOYMENT.md.',
    );
  }
  return secret;
}

function createAuth() {
  return betterAuth({
    // Pool client: auth routes run on the Node runtime, and the adapter gets a
    // client that can do everything rather than the transactionless HTTP one.
    database: drizzleAdapter(getDbTx(), {
      provider: 'pg',
      usePlural: false,
      schema,
    }),
    secret: requireSecret(),

    // SECURITY BOUNDARY — see src/lib/auth/origins.ts. Both values derive from
    // environment configuration only, never from a request's Host header.
    baseURL: resolveBaseUrl(process.env),
    trustedOrigins: resolveTrustedOrigins(process.env),

    emailAndPassword: {
      enabled: true,
    },
  });
}

/** Derived from the factory: betterAuth's return type is generic over its exact options. */
export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
