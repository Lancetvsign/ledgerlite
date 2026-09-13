import 'server-only';

import { and, count, eq, inArray, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { log } from '@/lib/logging';
import { recordAuditEvent } from '@/server/audit';
import { requireCompanyMembership, requirePermission } from '@/server/authorization';

import { installChartFromTemplate, installDefaultChart } from '@/server/accounts/internal';

import { CompanyError } from './errors';
import { lockActiveCompany, selectActiveMembers, selectTemplateCompany } from './internal';

export { CompanyError, type CompanyErrorCode } from './errors';

import type { AppUser, Company, CompanyMembership } from '@/db/schema';
import type { CoaChoice } from '@/server/accounts/default-coa';
import type { CreateCompanyInput, UpdateCompanySettingsInput } from '@/validation/company';

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
export type ChartSource = CoaChoice | 'template';

export async function createCompanyWithOwner(
  ownerUserId: string,
  input: CreateCompanyInput,
  chart?: ChartSource,
): Promise<{ company: CompanyView; membership: CompanyMembership }> {
  return await getDbTx().transaction(async (tx) => {
    // 'template' (LL-083 / ADR-039): the master company's chart AND its three
    // settings are copied; the input's fiscalYearStartMonth/currencyCode/timezone
    // are ignored on purpose (Zod defaults make "explicitly provided" undetectable,
    // and the create form collects none of them).
    const template = chart === 'template' ? await selectTemplateCompany(tx) : undefined;
    if (chart === 'template' && template === undefined) {
      throw new CompanyError('NO_TEMPLATE', 'No master template company is designated.');
    }

    const companies = await tx
      .insert(schema.companies)
      .values({
        legalName: input.legalName,
        dbaName: input.dbaName,
        email: input.email,
        phone: input.phone,
        address: input.address,
        fiscalYearStartMonth: template?.fiscalYearStartMonth ?? input.fiscalYearStartMonth,
        currencyCode: template?.currencyCode ?? input.currencyCode,
        timezone: template?.timezone ?? input.timezone,
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
    if (template !== undefined) {
      await installChartFromTemplate(company.id, template.id, tx);
    } else if (chart !== undefined && chart !== 'template') {
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
  'company_invitations',
  'company_memberships',
] as const;

export type DeleteCompanyResult = { mode: 'archived' | 'purged' };

type Tx = Parameters<Parameters<ReturnType<typeof getDbTx>['transaction']>[0]>[0];

/**
 * Locks the company's counter row and counts its POSTED/REVERSED entries. Every
 * posting takes that counter row FOR UPDATE (ADR-003), so holding it serialises
 * the caller's decision against in-flight postings: the count cannot go stale
 * between "no posted entries" and whatever the caller does next.
 */
async function countPostedEntriesLocked(tx: Tx, companyId: string): Promise<number> {
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
  return posted?.n ?? 0;
}



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
    const company = await lockActiveCompany(tx, companyId);

    if (input.confirmLegalName.trim() !== company.legalName) {
      throw new CompanyError('NAME_MISMATCH', 'The typed name does not match the company legal name.');
    }

    const postedEntries = await countPostedEntriesLocked(tx, companyId);
    const [audited] = await tx
      .select({ n: count() })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.companyId, companyId));
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
      // An archived template releases the single template slot (LL-083).
      await tx
        .update(schema.companies)
        .set({ status: 'INACTIVE', isTemplate: false, updatedAt: sql`now()` })
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

/** Whether a master template company is designated — a boolean only, no identity (LL-083). */
export async function hasTemplateCompany(): Promise<boolean> {
  return (await selectTemplateCompany()) !== undefined;
}

/**
 * Drizzle carries the constraint name in the CAUSE chain, not the top message —
 * walk it (the same lesson accounts/index.ts records).
 */
export function errorChainText(error: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  let acc = '';
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    acc += ' ' + cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  return acc;
}

/**
 * Designates (`on`) or releases (`!on`) the master template — AUTHORIZED
 * (company.template, OWNER only) — LL-083 / ADR-039.
 *
 * - At most one template instance-wide: the partial unique index
 *   companies_one_template arbitrates; a loser surfaces as TEMPLATE_EXISTS.
 * - A template never holds history: designation refuses a company with any
 *   POSTED/REVERSED entry (counted under the counter lock), and the ledger refuses
 *   to post into a template. Together the template has zero entries, always.
 * - Releasing a non-template is a no-op (idempotent, no audit row).
 */
export async function setCompanyTemplate(
  actorUserId: string,
  companyId: string,
  on: boolean,
): Promise<CompanyView> {
  await requirePermission(actorUserId, companyId, 'company.template');

  try {
    return await getDbTx().transaction(async (tx) => {
      const company = await lockActiveCompany(tx, companyId);
      if (company.isTemplate === on) return toView(company);

      if (on) {
        const posted = await countPostedEntriesLocked(tx, companyId);
        if (posted > 0) {
          throw new CompanyError('TEMPLATE_HAS_POSTINGS', 'A company with posted history cannot be the template.');
        }
      }

      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'COMPANY_UPDATED',
        entityType: 'company',
        entityId: companyId,
        before: { isTemplate: company.isTemplate },
        after: { isTemplate: on },
      });
      const rows = await tx
        .update(schema.companies)
        .set({ isTemplate: on, updatedAt: sql`now()` })
        .where(eq(schema.companies.id, companyId))
        .returning();
      const updated = rows[0];
      if (updated === undefined) throw new Error('company update returned no row');
      return toView(updated);
    });
  } catch (error) {
    if (/companies_one_template/.test(errorChainText(error))) {
      throw new CompanyError('TEMPLATE_EXISTS', 'Another company is already the master template.');
    }
    throw error;
  }
}

/**
 * Updates the "typical settings" (fiscal year start, currency, timezone) —
 * AUTHORIZED (company.manage) — LL-083. Refused once the company has posted
 * history (SETTINGS_LOCKED): the fiscal-year start drives period boundaries and
 * the year-end close, and a currency change under history would misstate every
 * figure. In practice this edits the template company; the UI offers it there only.
 */
export async function updateCompanySettings(
  actorUserId: string,
  companyId: string,
  input: UpdateCompanySettingsInput,
): Promise<CompanyView> {
  await requirePermission(actorUserId, companyId, 'company.manage');

  return await getDbTx().transaction(async (tx) => {
    const company = await lockActiveCompany(tx, companyId);
    const posted = await countPostedEntriesLocked(tx, companyId);
    if (posted > 0) {
      throw new CompanyError('SETTINGS_LOCKED', 'Settings cannot change once the company has posted entries.');
    }

    const before = {
      fiscalYearStartMonth: company.fiscalYearStartMonth,
      currencyCode: company.currencyCode,
      timezone: company.timezone,
    };
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'COMPANY_UPDATED',
      entityType: 'company',
      entityId: companyId,
      before,
      after: { ...input },
    });
    const rows = await tx
      .update(schema.companies)
      .set({ ...input, updatedAt: sql`now()` })
      .where(eq(schema.companies.id, companyId))
      .returning();
    const updated = rows[0];
    if (updated === undefined) throw new Error('company update returned no row');
    return toView(updated);
  });
}
