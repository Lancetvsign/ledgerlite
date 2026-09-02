/**
 * Accounting periods — LL-022. The full ticket list.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { addMembershipAs } from '@/server/companies';
import {
  assertPeriodOpen,
  closePeriod,
  getAccountingPeriod,
  listPeriods,
  reopenPeriod,
} from '@/server/periods';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

import type { PeriodError } from '@/server/periods';

import type { AppUser, Company } from '@/db/schema';

const COMPANY = createCompanyInput.parse({ legalName: 'Alpha LLC', timezone: 'America/Chicago' });

async function makeUser(email: string): Promise<AppUser> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: email.split('@')[0] ?? email },
    returnHeaders: true,
  });
  return await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
}
async function makeOwner(email: string): Promise<{ user: AppUser; company: Company }> {
  const user = await makeUser(email);
  const { company } = await createCompanyWithOwner(user.id, COMPANY);
  return { user, company: company as Company };
}

beforeEach(async () => {
  await truncateAll();
});

describe('lazy generation and date lookup', () => {
  it('creates the containing month on first lookup, then reuses it', async () => {
    const { company } = await makeOwner('o@synthetic.test');
    const p1 = await getAccountingPeriod(company.id, '2026-03-15');
    expect(p1.startDate).toBe('2026-03-01');
    expect(p1.endDate).toBe('2026-03-31');
    const p2 = await getAccountingPeriod(company.id, '2026-03-28');
    expect(p2.id).toBe(p1.id); // same month, same row
  });

  it('resolves both period boundaries to the same period', async () => {
    const { company } = await makeOwner('o@synthetic.test');
    const first = await getAccountingPeriod(company.id, '2026-04-01');
    const last = await getAccountingPeriod(company.id, '2026-04-30');
    expect(last.id).toBe(first.id);
  });

  it('rejects a non-calendar date', async () => {
    const { company } = await makeOwner('o@synthetic.test');
    const err = await getAccountingPeriod(company.id, '2026-02-30').catch((e: unknown) => e);
    expect((err as PeriodError).code).toBe('INVALID_DATE');
  });

  it('handles a fiscal year not starting in January (periods are plain months)', async () => {
    // A July-fiscal company still posts against calendar months; a June date
    // resolves to that June, a July date to that July.
    const { company } = await makeOwner('o@synthetic.test');
    const june = await getAccountingPeriod(company.id, '2026-06-15');
    const july = await getAccountingPeriod(company.id, '2026-07-15');
    expect(june.startDate).toBe('2026-06-01');
    expect(july.startDate).toBe('2026-07-01');
    expect(june.id).not.toBe(july.id);
  });
});

describe('overlap prevention (database)', () => {
  it('rejects an overlapping period at the raw SQL layer', async () => {
    const { company } = await makeOwner('o@synthetic.test');
    const db = await getTestDb();
    await db.execute(sql`insert into accounting_periods (company_id, start_date, end_date) values (${company.id}, '2026-01-01', '2026-01-31')`);
    const err = await db.execute(
      sql`insert into accounting_periods (company_id, start_date, end_date) values (${company.id}, '2026-01-10', '2026-02-10')`,
    ).catch((e: unknown) => e);
    expect(String((err as Error).cause ?? err)).toMatch(/accounting_periods_no_overlap|exclusion/i);
  });

  it('two CONCURRENT lookups of the same month yield ONE period, not two', async () => {
    // The race the exclusion constraint exists to win: both callers see no
    // period, both try to create March, one succeeds, the other re-reads.
    const { company } = await makeOwner('o@synthetic.test');
    const results = await Promise.all([
      getAccountingPeriod(company.id, '2026-05-15'),
      getAccountingPeriod(company.id, '2026-05-20'),
      getAccountingPeriod(company.id, '2026-05-25'),
    ]);
    const ids = new Set(results.map((p) => p.id));
    expect(ids.size).toBe(1);
    const db = await getTestDb();
    const count = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from accounting_periods where company_id = ${company.id} and start_date = '2026-05-01'`,
    );
    expect(count.rows[0]?.n).toBe('1');
  });
});

describe('close and reopen', () => {
  it('closes an open period, recording who and when', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const period = await getAccountingPeriod(company.id, '2026-01-15');
    const closed = await closePeriod(user.id, company.id, period.id);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedBy).toBe(user.id);
    expect(closed.closedAt).not.toBeNull();
  });

  it('assertPeriodOpen throws PERIOD_CLOSED after close, passes after reopen', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const period = await getAccountingPeriod(company.id, '2026-01-15');
    await expect(assertPeriodOpen(company.id, '2026-01-15')).resolves.toBeUndefined();

    await closePeriod(user.id, company.id, period.id);
    const err = await assertPeriodOpen(company.id, '2026-01-20').catch((e: unknown) => e);
    expect((err as PeriodError).code).toBe('PERIOD_CLOSED');

    await reopenPeriod(user.id, company.id, period.id);
    await expect(assertPeriodOpen(company.id, '2026-01-15')).resolves.toBeUndefined();
  });

  it('denies close to a user without period.close', async () => {
    const { user: owner, company } = await makeOwner('o@synthetic.test');
    const reader = await makeUser('r@synthetic.test');
    await addMembershipAs(owner.id, company.id, reader.id, 'READ_ONLY');
    const period = await getAccountingPeriod(company.id, '2026-01-15');
    // READ_ONLY lacks period.close → uniform AuthorizationDenied (not PeriodError)
    await expect(closePeriod(reader.id, company.id, period.id)).rejects.toThrow();
    // and the period stays open
    const [p] = await listPeriods(owner.id, company.id);
    expect(p?.status).toBe('OPEN');
  });

  it('rejects closing an already-closed period and reopening an already-open one', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const period = await getAccountingPeriod(company.id, '2026-01-15');
    await closePeriod(user.id, company.id, period.id);
    expect((await closePeriod(user.id, company.id, period.id).catch((e: unknown) => e) as PeriodError).code)
      .toBe('PERIOD_ALREADY_CLOSED');
    await reopenPeriod(user.id, company.id, period.id);
    expect((await reopenPeriod(user.id, company.id, period.id).catch((e: unknown) => e) as PeriodError).code)
      .toBe('PERIOD_ALREADY_OPEN');
  });

  it("denies a wrong-company period id", async () => {
    const { user, company } = await makeOwner('a@synthetic.test');
    const other = await makeOwner('b@synthetic.test');
    const otherPeriod = await getAccountingPeriod(other.company.id, '2026-01-15');
    // user has period.close in THEIR company, but names another company's period
    // under their own company id → not found in that scope.
    const err = await closePeriod(user.id, company.id, otherPeriod.id).catch((e: unknown) => e);
    expect((err as PeriodError).code).toBe('PERIOD_NOT_FOUND');
  });
});

describe('audit events for transitions', () => {
  it('writes ACCOUNTING_PERIOD_CLOSED and _REOPENED with before/after', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const period = await getAccountingPeriod(company.id, '2026-01-15');
    await closePeriod(user.id, company.id, period.id);
    await reopenPeriod(user.id, company.id, period.id);
    const db = await getTestDb();
    const r = await db.execute<{ action: string; before_json: { status?: string }; after_json: { status?: string } }>(
      sql`select action, before_json, after_json from audit_events
          where company_id = ${company.id} and entity_type = 'accounting_period'
          order by created_at`,
    );
    expect(r.rows.map((x) => x.action)).toEqual(['ACCOUNTING_PERIOD_CLOSED', 'ACCOUNTING_PERIOD_REOPENED']);
    expect(r.rows[0]?.before_json?.status).toBe('OPEN');
    expect(r.rows[0]?.after_json?.status).toBe('CLOSED');
    expect(r.rows[1]?.after_json?.status).toBe('OPEN');
  });

  it('writes NO audit event when the close transaction rolls back', async () => {
    const { user, company } = await makeOwner('o@synthetic.test');
    const period = await getAccountingPeriod(company.id, '2026-01-15');
    // Close it once so a second close fails AFTER auth but the audit is only
    // reached on the successful path — here we prove the inverse: a failed
    // close (already closed) writes no audit row.
    await closePeriod(user.id, company.id, period.id);
    const db = await getTestDb();
    const before = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_events where company_id = ${company.id}`,
    );
    await closePeriod(user.id, company.id, period.id).catch(() => undefined); // ALREADY_CLOSED
    const after = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_events where company_id = ${company.id}`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n); // no new event from the failed close
  });
});
