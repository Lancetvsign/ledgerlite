import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';

import { chartFor, REQUIRED_SYSTEM_ACCOUNTS, type CoaChoice } from './default-coa';

import type { PoolDatabase } from '@/db';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * UNAUTHORIZED-BY-DEFAULT default-chart install. In this fence-covered module
 * (src/app/** cannot import *_/internal) after the Gate 2A review flagged that
 * it lived in installer.ts, one import away from a route with no lint to stop
 * an attacker-supplied companyId. Callers: company creation (into the just-made
 * company, in-tx, before any capability exists) and the authorized
 * installDefaultChartFor. Idempotent via ON CONFLICT on (company_id,
 * account_number).
 */
export async function installDefaultChart(
  companyId: string,
  choice: CoaChoice,
  tx?: Tx,
): Promise<number> {
  const executor = tx ?? getDbTx();
  const chart = chartFor(choice);

  const result = await executor
    .insert(schema.accounts)
    .values(
      chart.map((a) => ({
        companyId,
        accountNumber: a.accountNumber,
        name: a.name,
        accountType: a.accountType,
        accountSubtype: a.accountSubtype,
        systemAccountType: a.systemAccountType ?? null,
        cashFlowCategory: a.cashFlowCategory ?? null,
      })),
    )
    // The idempotency mechanism: a re-run (or a concurrent install) collides and
    // inserts nothing, rather than duplicating. Untargeted so it covers EVERY
    // unique constraint on accounts — both (company_id, account_number) AND the
    // (company_id, system_account_type) index (LL-042): a second install of the
    // A/R account conflicts on the system-type index too, and targeting only
    // account_number would let that surface as a duplicate-key error.
    .onConflictDoNothing()
    .returning({ id: schema.accounts.id });

  return result.length; // rows actually inserted this run (0 on a repeat)
}

/**
 * Copies the master template company's ACTIVE chart into a brand-new company
 * (LL-083 / ADR-039), then installs the required system accounts as a safety net.
 *
 * Structurally scoped: the SELECT joins on companies.is_template = true, so even
 * an internal caller cannot copy an arbitrary company's chart. Ids are
 * pre-generated so parent links remap in a single insert (a parent that is
 * INACTIVE is not copied; its children become top-level). No balances, no
 * documents — account structure only, exactly like installDefaultChart.
 *
 * The safety net (`installDefaultChart(companyId, 'system-only', tx)`) relies on
 * that installer's untargeted ON CONFLICT DO NOTHING: a template that renumbered
 * A/R still yields exactly one ACCOUNTS_RECEIVABLE (conflict on the system-type
 * index), and a template missing a required account still yields it. Every
 * company therefore always has A/R, A/P, Retained Earnings and Opening Balance
 * Equity, whatever the template looks like.
 */
export async function installChartFromTemplate(
  companyId: string,
  templateCompanyId: string,
  tx: Tx,
): Promise<number> {
  const source = await tx
    .select({ account: schema.accounts })
    .from(schema.accounts)
    .innerJoin(schema.companies, eq(schema.accounts.companyId, schema.companies.id))
    .where(
      and(
        eq(schema.companies.id, templateCompanyId),
        eq(schema.companies.isTemplate, true),
        eq(schema.companies.status, 'ACTIVE'),
        eq(schema.accounts.status, 'ACTIVE'),
      ),
    );

  const idMap = new Map(source.map((r) => [r.account.id, randomUUID()] as const));
  // Parents first. Postgres checks the FK at statement end, so row order is not
  // required for correctness; it keeps the copied chart readable when inspected.
  const ordered = [...source].sort((a, b) => {
    const pa = a.account.parentAccountId === null ? 0 : 1;
    const pb = b.account.parentAccountId === null ? 0 : 1;
    return pa - pb || (a.account.accountNumber ?? '').localeCompare(b.account.accountNumber ?? '');
  });

  if (ordered.length > 0) {
    await tx.insert(schema.accounts).values(
      ordered.map(({ account: a }) => ({
        id: idMap.get(a.id),
        companyId,
        accountNumber: a.accountNumber,
        name: a.name,
        accountType: a.accountType,
        accountSubtype: a.accountSubtype,
        parentAccountId:
          a.parentAccountId === null ? null : (idMap.get(a.parentAccountId) ?? null),
        systemAccountType: a.systemAccountType,
        cashFlowCategory: a.cashFlowCategory,
        description: a.description,
      })),
    );
  }

  await installDefaultChart(companyId, 'system-only', tx);

  // A required role can still be missing after that: e.g. a chart-less template
  // that owns a non-A/R account numbered 1100 blocks the numbered A/R insert on
  // the number unique. Insert any missing role UNNUMBERED — the number is a
  // convenience, the role is the guarantee.
  const present = new Set(
    (
      await tx
        .select({ role: schema.accounts.systemAccountType })
        .from(schema.accounts)
        .where(eq(schema.accounts.companyId, companyId))
    ).map((r) => r.role),
  );
  const missing = REQUIRED_SYSTEM_ACCOUNTS.filter((a) => !present.has(a.systemAccountType ?? null));
  if (missing.length > 0) {
    await tx.insert(schema.accounts).values(
      missing.map((a) => ({
        companyId,
        accountNumber: null,
        name: a.name,
        accountType: a.accountType,
        accountSubtype: a.accountSubtype,
        systemAccountType: a.systemAccountType ?? null,
        cashFlowCategory: a.cashFlowCategory ?? null,
      })),
    );
  }
  return ordered.length;
}
