import { describe, expect, it } from 'vitest';

import { resolveBaseUrl, resolveTrustedOrigins } from '@/lib/auth/origins';

describe('resolveBaseUrl', () => {
  it('prefers explicit BETTER_AUTH_URL', () => {
    expect(
      resolveBaseUrl({ BETTER_AUTH_URL: 'https://ledgerlite.example', VERCEL_URL: 'x.vercel.app' }),
    ).toBe('https://ledgerlite.example');
  });

  it('strips a trailing slash, which would break origin comparison', () => {
    expect(resolveBaseUrl({ BETTER_AUTH_URL: 'https://ledgerlite.example/' })).toBe(
      'https://ledgerlite.example',
    );
  });

  it('falls back to the platform deployment URL, adding the scheme Vercel omits', () => {
    expect(resolveBaseUrl({ VERCEL_URL: 'ledgerlite-abc123.vercel.app' })).toBe(
      'https://ledgerlite-abc123.vercel.app',
    );
  });

  it('REFUSES to guess in production', () => {
    // A guessed base URL in production scopes auth cookies to the wrong host.
    // Misconfiguration must fail deployment, not limp along.
    expect(() =>
      resolveBaseUrl({ NODE_ENV: 'production', VERCEL_ENV: 'production' }),
    ).toThrow(/BETTER_AUTH_URL is not set/);
  });

  it('falls back to localhost for development', () => {
    expect(resolveBaseUrl({})).toBe('http://localhost:3000');
  });
});

describe('resolveTrustedOrigins', () => {
  it('is an allowlist: base URL plus platform-injected deployment URLs only', () => {
    const origins = resolveTrustedOrigins({
      BETTER_AUTH_URL: 'https://ledgerlite.example',
      VERCEL_URL: 'ledgerlite-abc123.vercel.app',
      VERCEL_BRANCH_URL: 'ledgerlite-git-feat-x.vercel.app',
      VERCEL_ENV: 'production',
    });
    expect(origins).toContain('https://ledgerlite.example');
    expect(origins).toContain('https://ledgerlite-abc123.vercel.app');
    expect(origins).toContain('https://ledgerlite-git-feat-x.vercel.app');
  });

  it('NEVER contains a wildcard', () => {
    // A *.vercel.app wildcard would trust every Vercel deployment on the
    // planet, including an attacker's. If someone adds one, this fails.
    const shapes = [
      {},
      { VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app' },
      { VERCEL_ENV: 'production', BETTER_AUTH_URL: 'https://ledgerlite.example' },
    ];
    for (const env of shapes) {
      for (const origin of resolveTrustedOrigins(env)) {
        expect(origin).not.toContain('*');
      }
    }
  });

  it('excludes localhost in production', () => {
    const origins = resolveTrustedOrigins({
      BETTER_AUTH_URL: 'https://ledgerlite.example',
      VERCEL_ENV: 'production',
    });
    expect(origins.some((o) => o.includes('localhost'))).toBe(false);
    expect(origins.some((o) => o.includes('127.0.0.1'))).toBe(false);
  });

  it('includes localhost variants outside production, covering the E2E port', () => {
    const origins = resolveTrustedOrigins({});
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://127.0.0.1:3200');
  });

  it('takes nothing from a request: identical env yields identical origins', () => {
    const env = { BETTER_AUTH_URL: 'https://ledgerlite.example', VERCEL_ENV: 'production' };
    expect(resolveTrustedOrigins(env)).toEqual(resolveTrustedOrigins(env));
  });
});
