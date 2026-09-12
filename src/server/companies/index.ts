import 'server-only';

import { and, count, eq, inArray, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { log } from '@/lib/logging';
import { recordAuditEvent } from '@/server/audit';
import { AuthorizationDenied, requireCompanyMembership, requirePermission } from '@/server/authorization';

import { installDefaultChart } from '@/server/accounts/internal';

import { CompanyError } from './errors';
import { insertMembership, selectActiveMembers } from './internal';

export { CompanyError, type CompanyErrorCode } from './errors';

import type { AppUser, Company, CompanyMembership } from '@/db/schema';
import type { CoaChoice } from '@/server/accounts/default-coa';
import type { CreateCompanyInput } from '@/validation/company';

/**
 * What services RETURN for a company. `ein` is deliberately not here: the
 * protected column never travels in a default shape, so forgetting to strip it
 * at a call site is not possible — there is nothing to strip.
 */
export type CompanyView = Omit<Company, 'ein'>;

function toView(company: Company): CompanyView {
  const { ein: _ein, ...view } = company;
  return view;
}

/**
 * Creates a company and its creator's OWNER membership — one transaction on
 * the Pool client. Either both exist or neither does; no window may exist in
 * which a company has no owner (AGENTS.md §6: an ownerless company is a
 * tenant nobody can administer).
 *
 * Caller passes a VALIDATED input (the parsed Zod type) and an existing app
 * user id. Authentication is the only prerequisite — any signed-in user may
 * create a company and becomes its OWNER. What OWNER may *do* is LL-012's
 * capability model; company-scoped authorization for everything else is LL-013.
 */
export async function createCompanyWithOwner(
  ownerUserId: string,
  input: CreateCompanyInput,
  chart?: CoaChoice,
): Promise<{ company: CompanyView; membership: CompanyMembership }> {
  return await getDbTx().transaction(async (tx) => {
    const companies = await tx
      .insert(schema.companies)
      .values({
        legalName: input.legalName,
        dbaName: input.dbaName,
        email: input.email,
        phone: input.phone,
        address: input.address,
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        currencyCode: input.currencyCode,
        timezone: input.timezone,
      })
      .returning();

    const company = companies[0];
    if (company === undefined) throw new Error('company insert returned no row');

    const memberships = await tx
      .insert(schema.companyMemberships)
      .values({ companyId: company.id, userId: ownerUserId, role: 'OWNER' })
      .returning();

    const membership = memberships[0];
    if (membership === undefined) throw new Error('membership insert returned no row');

    // Seed the gapless entry-number counter atomically with the company
    // (ADR-003). Without this, the first posting for a new company would find
    // no counter row.
    await tx.insert(schema.companyCounters).values({ companyId: company.id });

    // Install a chart in the SAME transaction when one is chosen (LL-023).
    // Omitted (undefined) installs nothing — the company is still valid, and a
    // setup screen can install later via installDefaultChartFor. When a chart
    // IS chosen, the required system accounts arrive atomically with the company.
    if (chart !== undefined) {
      await installDefaultChart(company.id, chart, tx);
    }

    return { company: toView(company), membership };
  });
}

/** Companies where the user holds an ACTIVE membership and the company is ACTIVE. */
/**
 * The company's calendar "today" (YYYY-MM-DD in its timezone) — the default date for every
 * document form and report (ADR-007). Never `new Date().toISOString()`: that is UTC's day,
 * which for a US company is already tomorrow every evening, so a bill entered at 8pm would
 * post into the next day and drop out of "as of today" reports.
 */
export async function companyToday(actorUserId: string, companyId: string): Promise<string> {
  await requireCompanyMembership(actorUserId, companyId);
  const rows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  return todayInTimeZone(rows[0]?.timezone ?? 'UTC');
}

export async function listCompaniesForUser(
  userId: string,
): Promise<{ company: CompanyView; role: CompanyMembership['role'] }[]> {
  const rows = await getDbTx()
    .select({ company: schema.companies, role: schema.companyMemberships.role })
    .from(schema.companyMemberships)
    .innerJoin(schema.companies, eq(schema.companyMemberships.companyId, schema.companies.id))
    .where(
      and(
        eq(schema.companyMemberships.userId, userId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
        eq(schema.companies.status, 'ACTIVE'),
      ),
    );
  return rows.map((r) => ({ company: toView(r.company), role: r.role }));
}

/**
 * Active members of one company — AUTHORIZED. Any active member may see the
 * roster of their own company; nobody sees anyone else's. Hardened after the
 * LL-014 adversarial pass flagged the unauthorized repo read as the leak
 * waiting for its first careless route.
 */
export async function listMembersForCompany(
  actorUserId: string,
  companyId: string,
): Promise<{ user: AppUser; role: CompanyMembership['role'] }[]> {
  await requireCompanyMembership(actorUserId, companyId);
  return await selectActiveMembers(companyId);
}

/**
 * Grants a membership — AUTHORIZED (user.manage). The raw insert lives in
 * ./internal.ts, reachable only from server code; this is the front door the
 * future invite flow uses.
 */
export async function addMembershipAs(
  actorUserId: string,
  companyId: string,
  targetUserId: string,
  role: CompanyMembership['role'],
): Promise<CompanyMembership> {
  await requirePermission(actorUserId, companyId, 'user.manage');
  return await insertMembership(companyId, targetUserId, role);
}

/** The question LL-013's authorization layer will ask on every request. */
export async function hasActiveMembership(userId: string, companyId: string): Promise<boolean> {
  const rows = await getDbTx()
    .select({ id: schema.companyMemberships.id })
    .from(schema.companyMemberships)
    .where(
      and(
        eq(schema.companyMemberships.userId, userId),
        eq(schema.companyMemberships.companyId, companyId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}


/**
 * Tenant-owned tables, CHILDREN FIRST, for the purge path of deleteCompany. Every
 * table here carries a company_id; the integration suite (company-delete.test.ts)
 * compares this list against information_schema so a new tenant table cannot be
 * forgotten. `audit_events` is deliberately absent: it is append-only at the
 * database (migration 0004), so a company that has ANY audit history can never be
 * purged — it is archived instead (ADR-038).
 */
export const PURGE_ORDER = [
  'bank_reconciliation_lines',
  'bank_reconciliations',
  'bank_import_lines',
  'bank_import_batches',
  'payment_applications',
  'bill_payment_applications',
  'writeoffs',
  'credit_memos',
  'vendor_credits',
  'payments',
  'bill_payments',
  'invoice_lines',
  'invoices',
  'bill_lines',
  'bills',
  'journal_lines',
  'journal_entries',
  'accounting_periods',
  'company_counters',
  'accounts',
  'customers',
  'vendors',
  'company_memberships',
] as const;

export type DeleteCompanyResult = { mode: 'archived' | 'purged' };

/**
 * Deletes a company — AUTHORIZED (company.delete, OWNER only) — LL-082 / ADR-038.
 *
 * Two outcomes, decided inside the transaction under a row lock:
 * - ARCHIVE when the company has any posted/reversed journal entry OR any audit
 *   event. Status becomes INACTIVE: it vanishes from every listing and every
 *   membership check fails closed (requireCompanyMembership requires an ACTIVE
 *   company), while every row is retained. Financial history is never destroyed.
 * - PURGE only when nothing has ever been recorded about the company (no postings,
 *   no audit trail): the rows are physically deleted, children first, in one
 *   transaction. Because the audit log is append-only at the database, this is
 *   the only case in which a physical delete is even possible.
 *
 * The caller must retype the company's legal name exactly. Authorization runs
 * BEFORE the name comparison so a mismatch never becomes an oracle for a company
 * the actor does not own.
 */
export async function deleteCompany(
  actorUserId: string,
  companyId: string,
  input: { confirmLegalName: string },
): Promise<DeleteCompanyResult> {
  await requirePermission(actorUserId, companyId, 'company.delete');

  return await getDbTx().transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(schema.companies)
      .where(and(eq(schema.companies.id, companyId), eq(schema.companies.status, 'ACTIVE')))
      .for('update');
    const company = locked[0];
    // Archived (or gone) between the permission check and the lock: same denial
    // shape as any other missing company — never a distinguishable "already deleted".
    if (company === undefined) throw new AuthorizationDenied();

    if (input.confirmLegalName.trim() !== company.legalName) {
      throw new CompanyError('NAME_MISMATCH', 'The typed name does not match the company legal name.');
    }

    // Every posting takes the company's counter row FOR UPDATE (ADR-003), so holding
    // it here serialises this decision against in-flight postings: the count below
    // cannot go stale between "no posted entries" and the purge.
    await tx
      .select({ companyId: schema.companyCounters.companyId })
      .from(schema.companyCounters)
      .where(eq(schema.companyCounters.companyId, companyId))
      .for('update');

    const [posted] = await tx
      .select({ n: count() })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          inArray(schema.journalEntries.status, ['POSTED', 'REVERSED']),
        ),
      );
    const [audited] = await tx
      .select({ n: count() })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.companyId, companyId));
    const postedEntries = posted?.n ?? 0;
    const auditEvents = audited?.n ?? 0;

    if (postedEntries > 0 || auditEvents > 0) {
      // Audit first, inside the same transaction: a rolled-back archive leaves no
      // record of an archive that never happened.
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'COMPANY_ARCHIVED',
        entityType: 'company',
        entityId: companyId,
        before: { status: company.status },
        after: { status: 'INACTIVE', postedEntries, auditEvents },
      });
      await tx
        .update(schema.companies)
        .set({ status: 'INACTIVE', updatedAt: sql`now()` })
        .where(eq(schema.companies.id, companyId));
      return { mode: 'archived' };
    }

    for (const table of PURGE_ORDER) {
      await tx.execute(sql`delete from ${sql.identifier(table)} where company_id = ${companyId}`);
    }
    await tx.delete(schema.companies).where(eq(schema.companies.id, companyId));
    // Ids only — never the company's name or any content (AGENTS.md §9).
    log.info('company purged', { companyId, actorUserId, tables: PURGE_ORDER.length });
    return { mode: 'purged' };
  });
}
