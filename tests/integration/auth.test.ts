/**
 * Authentication flows against the real database.
 *
 * Everything goes through Better Auth's own API surface — the same code paths
 * the routes use. No test writes an auth table directly: that would prove a
 * state the application cannot actually produce.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';

import { truncateAll } from '../helpers/database';

const EMAIL = 'user-a@synthetic.test';
const PASSWORD = 'synthetic-password-1';

/** Sign up and return the session cookie the browser would have received. */
async function signUpAndGetCookie(email = EMAIL): Promise<string> {
  const { headers } = await getAuth().api.signUpEmail({
    body: { email, password: PASSWORD, name: 'Synthetic User' },
    returnHeaders: true,
  });
  const setCookie = headers.get('set-cookie');
  if (setCookie === null) throw new Error('sign-up returned no session cookie');
  // "name=value; Path=/; HttpOnly..." — the request needs only "name=value".
  return setCookie.split(';')[0] ?? '';
}

const asHeaders = (cookie: string): Headers => new Headers({ cookie });

beforeEach(async () => {
  await truncateAll();
});

describe('session lifecycle', () => {
  it('refuses an unauthenticated request', async () => {
    const session = await getAuth().api.getSession({ headers: new Headers() });
    expect(session).toBeNull();
  });

  it('grants a session on sign-up and honours it', async () => {
    const cookie = await signUpAndGetCookie();
    const session = await getAuth().api.getSession({ headers: asHeaders(cookie) });
    expect(session?.user.email).toBe(EMAIL);
  });

  it('signs in with correct credentials and refuses wrong ones', async () => {
    await signUpAndGetCookie();

    const ok = await getAuth().api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      returnHeaders: true,
    });
    expect(ok.headers.get('set-cookie')).not.toBeNull();

    await expect(
      getAuth().api.signInEmail({ body: { email: EMAIL, password: 'wrong-password-1' } }),
    ).rejects.toThrow();
  });

  it('refuses a tampered session token', async () => {
    const cookie = await signUpAndGetCookie();
    const [name, value] = cookie.split('=') as [string, string];
    // Flip the tail of the token. The signature no longer matches.
    const tampered = `${name}=${value.slice(0, -4)}XXXX`;
    const session = await getAuth().api.getSession({ headers: asHeaders(tampered) });
    expect(session).toBeNull();
  });

  it('logout genuinely invalidates: the OLD cookie stops working', async () => {
    // The assertion the ticket demands. Rendering a signed-out page proves
    // nothing — the revoked cookie itself must be dead server-side.
    const cookie = await signUpAndGetCookie();
    expect((await getAuth().api.getSession({ headers: asHeaders(cookie) }))?.user.email).toBe(
      EMAIL,
    );

    await getAuth().api.signOut({ headers: asHeaders(cookie) });

    const after = await getAuth().api.getSession({ headers: asHeaders(cookie) });
    expect(after).toBeNull();
  });

  it('authentication grants no application capability (nothing to grant yet)', async () => {
    // Guardrail for the sprint: LL-010 must not smuggle in authorization.
    // The session carries identity only — no companies, roles or permissions.
    const cookie = await signUpAndGetCookie();
    const session = await getAuth().api.getSession({ headers: asHeaders(cookie) });
    expect(session).not.toBeNull();
    expect(Object.keys(session?.user ?? {})).not.toContain('companies');
    expect(Object.keys(session?.user ?? {})).not.toContain('permissions');
    expect(Object.keys(session?.user ?? {})).not.toContain('role');
  });
});

describe('origin enforcement — the security boundary', () => {
  it('rejects a state-changing request whose Host and Origin are forged', async () => {
    // The base URL comes from environment configuration, never from the
    // request. An attacker controlling their own Host/Origin headers must not
    // be able to make the server treat their origin as trusted.
    const response = await getAuth().handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          host: 'evil.example',
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('accepts the same request from a trusted origin', async () => {
    await signUpAndGetCookie();
    const response = await getAuth().handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(200);
  });
});
