/**
 * Invitation-only sign-up — LL-090 (ADR-041 amendment). Against the real auth instance:
 * in 'invitation' mode the sign-up endpoint admits only a request carrying a live join
 * cookie; 'open' mode (every non-production environment by default) admits anyone.
 * The mode is read per request, so the variable is flipped inside the test.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { signUpMode } from '@/lib/auth/signup-mode';
import { createCompanyWithOwner } from '@/server/companies';
import { inviteMember } from '@/server/members';
import { JOIN_COOKIE } from '@/server/members/token';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

const password = 'synthetic-password-1';
const fresh = () => `su-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;

async function trySignUp(email: string, cookie?: string): Promise<'created' | number> {
  try {
    await getAuth().api.signUpEmail({
      body: { email, password, name: 'S' },
      ...(cookie === undefined ? {} : { headers: new Headers({ cookie: `${JOIN_COOKIE}=${cookie}` }) }),
    });
    return 'created';
  } catch (e) {
    const status = (e as { statusCode?: number; status?: number | string }).statusCode ?? (e as { status?: number | string }).status;
    return typeof status === 'number' ? status : 0;
  }
}

async function liveToken(): Promise<{ token: string; invitationId: string }> {
  const { response } = await getAuth().api.signUpEmail({ body: { email: fresh(), password, name: 'O' }, returnHeaders: true });
  const owner = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  const { company } = await createCompanyWithOwner(owner.id, createCompanyInput.parse({ legalName: 'Gate Co', timezone: 'UTC' }));
  const r = await inviteMember(owner.id, company.id, { email: fresh(), role: 'READ_ONLY' });
  if (r.mode !== 'invited') throw new Error('expected invitation');
  return { token: r.token, invitationId: r.invitationId };
}

const original = process.env['AUTH_SIGNUP_MODE'];
beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  if (original === undefined) delete process.env['AUTH_SIGNUP_MODE'];
  else process.env['AUTH_SIGNUP_MODE'] = original;
});

describe('signUpMode', () => {
  it('defaults to open outside production and to invitation in production; the variable overrides', () => {
    expect(signUpMode({ APP_ENV: 'test' })).toBe('open');
    expect(signUpMode({ APP_ENV: 'production' })).toBe('invitation');
    expect(signUpMode({ APP_ENV: 'production', AUTH_SIGNUP_MODE: 'open' })).toBe('open');
    expect(signUpMode({ APP_ENV: 'development', AUTH_SIGNUP_MODE: 'invitation' })).toBe('invitation');
  });
});

describe('the sign-up gate', () => {
  it('open mode admits anyone', async () => {
    process.env['AUTH_SIGNUP_MODE'] = 'open';
    expect(await trySignUp(fresh())).toBe('created');
  });

  it('invitation mode refuses a bare request and admits one carrying a live join cookie; expired or spent links are refused', async () => {
    process.env['AUTH_SIGNUP_MODE'] = 'open';
    const { token, invitationId } = await liveToken(); // the fixture itself needs open mode
    process.env['AUTH_SIGNUP_MODE'] = 'invitation';

    expect(await trySignUp(fresh())).toBe(403);
    expect(await trySignUp(fresh(), 'not-a-token')).toBe(403);
    expect(await trySignUp(fresh(), token)).toBe('created');

    const db = await getTestDb();
    await db.execute(sql`update company_invitations set expires_at = now() - interval '1 minute' where id = ${invitationId}`);
    expect(await trySignUp(fresh(), token)).toBe(403);
  });
});
