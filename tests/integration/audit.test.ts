/**
 * Append-only audit infrastructure — LL-021.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount, deactivateAccount } from '@/server/accounts';
import { recordAuditEvent } from '@/server/audit';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

import type { AppUser, Company } from '@/db/schema';

const COMPANY = createCompanyInput.parse({ legalName: 'Alpha LLC', timezone: 'America/Chicago' });

async function makeOwner(email: string): Promise<{ user: AppUser; company: Company }> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: email.split('@')[0] ?? email },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  const { company } = await createCompanyWithOwner(user.id, COMPANY);
  return { user, company: company as Company };
}

async function auditCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from audit_events where company_id = ${companyId}`,
  );
  return Number(r.rows[0]?.n ?? '0');
}

beforeEach(async () => {
  await truncateAll();
});

describe('append-only enforcement', () => {
  it('the database refuses UPDATE, for the owner role too', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const ev = await recordAuditEvent({
      companyId: company.id, actorUserId: user.id,
      action: 'ACCOUNT_CREATED', entityType: 'account', entityId: 'x',
    });
    const db = await getTestDb();
    const err = await db.execute(sql`update audit_events set entity_id = 'tampered' where id = ${ev.id}`)
      .catch((e: unknown) => e);
    expect(String((err as Error).cause ?? err)).toMatch(/append-only|not permitted/i);
  });

  it('the database refuses DELETE', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const ev = await recordAuditEvent({
      companyId: company.id, actorUserId: user.id,
      action: 'ACCOUNT_CREATED', entityType: 'account', entityId: 'x',
    });
    const db = await getTestDb();
    const err = await db.execute(sql`delete from audit_events where id = ${ev.id}`).catch((e: unknown) => e);
    expect(String((err as Error).cause ?? err)).toMatch(/append-only|not permitted/i);
    expect(await auditCount(company.id)).toBe(1); // still there
  });
});

describe('redaction before write', () => {
  it('a secret field never lands in before_json / after_json', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const SECRET = 'SENTINEL-audit-secret-MUST-NOT-PERSIST';
    await recordAuditEvent({
      companyId: company.id, actorUserId: user.id,
      action: 'ACCOUNT_UPDATED', entityType: 'account', entityId: 'x',
      before: { name: 'Cash', ein: SECRET, password: SECRET, nested: { token: SECRET } },
      after: { name: 'Cash', detail: `postgres://u:${SECRET}@h/d` },
    });
    const db = await getTestDb();
    const r = await db.execute<{ before_json: unknown; after_json: unknown }>(
      sql`select before_json, after_json from audit_events where company_id = ${company.id}`,
    );
    const blob = JSON.stringify(r.rows[0]);
    expect(blob).not.toContain(SECRET);
    expect(blob).toContain('[REDACTED]');
    // Non-secret fields survive — the record is still useful.
    expect(blob).toContain('Cash');
  });
});

describe('transactional atomicity — the core requirement', () => {
  it('createAccount writes the account AND its audit event together', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const acct = await createAccount(user.id, company.id,
      createAccountInput.parse({ name: 'Checking', accountType: 'ASSET' }));
    const db = await getTestDb();
    const r = await db.execute<{ action: string; entity_id: string }>(
      sql`select action, entity_id from audit_events where company_id = ${company.id}`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.action).toBe('ACCOUNT_CREATED');
    expect(r.rows[0]?.entity_id).toBe(acct.id);
  });

  it('deactivate records before AND after state in one transaction', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const acct = await createAccount(user.id, company.id,
      createAccountInput.parse({ name: 'Old', accountType: 'EXPENSE' }));
    await deactivateAccount(user.id, company.id, acct.id);
    const db = await getTestDb();
    const r = await db.execute<{ before_json: { status?: string }; after_json: { status?: string } }>(
      sql`select before_json, after_json from audit_events
          where company_id = ${company.id} and action = 'ACCOUNT_DEACTIVATED'`,
    );
    expect(r.rows[0]?.before_json?.status).toBe('ACTIVE');
    expect(r.rows[0]?.after_json?.status).toBe('INACTIVE');
  });

  it('a ROLLED-BACK action leaves NO audit event', async () => {
    // The ticket's decisive case: an audit row written in a separate
    // transaction could survive a rolled-back action, logging something that
    // never happened. Because the event shares the action's tx, a failure after
    // the audit insert removes both. We force a failure inside a transaction
    // that has already recorded an event and assert nothing persists.
    const { user, company } = await makeOwner('o@synthetic.test');
    const { getDbTx } = await import('@/db');
    await expect(
      getDbTx().transaction(async (tx) => {
        await recordAuditEvent({
          tx, companyId: company.id, actorUserId: user.id,
          action: 'ACCOUNT_CREATED', entityType: 'account', entityId: 'ghost',
        });
        throw new Error('simulated failure after the audit insert');
      }),
    ).rejects.toThrow('simulated failure');

    expect(await auditCount(company.id)).toBe(0); // the audit row rolled back with the action
  });
});

describe('correlation and scope', () => {
  it('captures the request id from context when present', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const { withRequestContext, newRequestId } = await import('@/lib/logging');
    const requestId = newRequestId();
    await withRequestContext({ requestId }, async () => {
      await recordAuditEvent({
        companyId: company.id, actorUserId: user.id,
        action: 'ACCOUNT_CREATED', entityType: 'account', entityId: 'x',
      });
    });
    const db = await getTestDb();
    const r = await db.execute<{ request_id: string }>(
      sql`select request_id from audit_events where company_id = ${company.id}`,
    );
    expect(r.rows[0]?.request_id).toBe(requestId);
  });
});
