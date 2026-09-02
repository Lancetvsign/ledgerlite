/**
 * Base URL and trusted-origin resolution for authentication.
 *
 * THIS IS A SECURITY BOUNDARY. The base URL decides where auth cookies are
 * scoped and which origins may make state-changing requests. Deriving it from a
 * request's Host or X-Forwarded-Host header would let any client that controls
 * its own headers impersonate the deployment — so nothing here reads a request.
 *
 * Everything below comes from the ENVIRONMENT: values we or the platform set at
 * deploy time. VERCEL_URL and VERCEL_BRANCH_URL are injected by Vercel per
 * deployment; a client cannot influence them.
 *
 * Pure functions over an explicit env object, so tests can exercise every
 * environment shape without touching process.env.
 */

export interface OriginEnv {
  readonly BETTER_AUTH_URL?: string | undefined;
  readonly VERCEL_URL?: string | undefined;
  readonly VERCEL_BRANCH_URL?: string | undefined;
  readonly VERCEL_ENV?: string | undefined; // 'production' | 'preview' | 'development'
  readonly NODE_ENV?: string | undefined;
}

const LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3100',
  'http://localhost:3200', // Playwright's production build
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3100',
  'http://127.0.0.1:3200',
] as const;

function normalize(url: string): string {
  // Platform variables arrive without a scheme ("my-app-abc123.vercel.app").
  const withScheme = /^https?:\/\//.test(url) ? url : `https://${url}`;
  // A trailing slash makes origin comparison fail; strip it.
  return withScheme.replace(/\/+$/, '');
}

/**
 * The canonical base URL for this deployment.
 *
 * Order: explicit configuration wins; otherwise the platform's own deployment
 * URL; otherwise localhost for development. Throws in production when nothing
 * is configured — a guessed base URL in production is a misconfiguration, not
 * a fallback.
 */
export function resolveBaseUrl(env: OriginEnv): string {
  if (env.BETTER_AUTH_URL !== undefined && env.BETTER_AUTH_URL.trim() !== '') {
    return normalize(env.BETTER_AUTH_URL);
  }
  if (env.VERCEL_URL !== undefined && env.VERCEL_URL.trim() !== '') {
    return normalize(env.VERCEL_URL);
  }
  if (env.NODE_ENV === 'production' && env.VERCEL_ENV === 'production') {
    throw new Error(
      'BETTER_AUTH_URL is not set in production. Refusing to guess a base URL: ' +
        'auth cookies and trusted origins would be scoped to the wrong host.',
    );
  }
  return 'http://localhost:3000';
}

/**
 * The exhaustive list of origins allowed to make state-changing auth requests.
 *
 * An ALLOWLIST, assembled from environment-provided values only:
 *   - the canonical base URL
 *   - this deployment's own Vercel URLs (unique per deployment, plus the stable
 *     branch alias) — injected by the platform, not taken from any header
 *   - localhost variants, outside production only
 *
 * Deliberately NOT here: wildcard *.vercel.app (would trust every Vercel
 * deployment on the planet), and anything read from a request.
 */
export function resolveTrustedOrigins(env: OriginEnv): string[] {
  const origins = new Set<string>([resolveBaseUrl(env)]);

  for (const platformUrl of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
    if (platformUrl !== undefined && platformUrl.trim() !== '') {
      origins.add(normalize(platformUrl));
    }
  }

  if (env.VERCEL_ENV !== 'production') {
    for (const local of LOCAL_ORIGINS) origins.add(local);
  }

  return [...origins];
}
