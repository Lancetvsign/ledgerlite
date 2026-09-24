import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb, getDbTx, schema } from '@/db';
import { requirePermission } from '@/server/authorization';

import { BankImportError } from './errors';
import { pickableAccounts } from './index';
import { transferCounterparts } from './intercompany';
import { visibleBatches } from './shared';

import type { HttpDatabase, PoolDatabase } from '@/db';
import type { BankImportDraftAction, BankImportLineDraft } from '@/db/schema';
import type { SaveReviewDraftsInput, SaveSharedDraftsInput } from '@/validation/bank-import';

/**
 * Review drafts — LL-105 / ADR-045. A reviewer's saved-but-not-posted choices, one row per
 * STAGED line per DRAFTING COMPANY (the cardholder on its own review screen; a member company
 * on the shared "take" screen). Scratch state with no ledger effect: saving never posts, an
 * account that is not the drafting company's own pickable account is stored as NULL rather
 * than refused (it can never be posted anyway), and a line that is no longer STAGED is simply
 * skipped — an autosave racing a post must not fail. The 0043 triggers keep the table honest:
 * no draft for a decided line, and every draft of a line is dropped when it leaves STAGED.
 */
export interface LineDraft {
  readonly action: BankImportDraftAction;
  readonly accountId: string | null;
  readonly documentId: string | null;
  readonly counterpartCompanyId: string | null;
  readonly updatedAt: Date;
}

type Executor = HttpDatabase | PoolDatabase;

function toView(d: BankImportLineDraft): LineDraft {
  return { action: d.action, accountId: d.accountId, documentId: d.documentId, counterpartCompanyId: d.counterpartCompanyId, updatedAt: d.updatedAt };
}

/** The drafting company's drafts for these lines, keyed by line id. Unauthorized — callers scope it. */
export async function draftsFor(exec: Executor, companyId: string, lineIds: readonly string[]): Promise<Map<string, LineDraft>> {
  const out = new Map<string, LineDraft>();
  if (lineIds.length === 0) return out;
  const rows = await exec
    .select()
    .from(schema.bankImportLineDrafts)
    .where(and(eq(schema.bankImportLineDrafts.companyId, companyId), inArray(schema.bankImportLineDrafts.lineId, [...lineIds])));
  for (const r of rows) out.set(r.lineId, toView(r));
  return out;
}

/** Draft counts per batch for the drafting company (the "in progress" signal). Unauthorized — callers scope it. */
export async function draftCountsByBatch(exec: Executor, companyId: string, batchIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (batchIds.length === 0) return out;
  const rows = await exec.execute<{ batch_id: string; n: string }>(sql`
    select l.batch_id::text as batch_id, count(*)::text as n
    from bank_import_line_drafts d
    join bank_import_lines l on l.id = d.line_id
    where d.company_id = ${companyId} and l.batch_id in (${sql.join(batchIds.map((b) => sql`${b}`), sql`, `)})
    group by l.batch_id`);
  for (const r of rows.rows) out.set(r.batch_id, Number(r.n));
  return out;
}

interface DraftRow {
  readonly lineId: string;
  readonly action: BankImportDraftAction;
  readonly accountId: string | null;
  readonly documentId: string | null;
  readonly counterpartCompanyId: string | null;
}

/** One upsert per row inside one transaction; a line that left STAGED meanwhile is skipped by the lock read. */
async function upsertDrafts(actorUserId: string, companyId: string, ownerCompanyId: string, batchId: string, rows: readonly DraftRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return await getDbTx().transaction(async (tx) => {
    const staged = new Set(
      (
        await tx
          .select({ id: schema.bankImportLines.id })
          .from(schema.bankImportLines)
          .where(
            and(
              eq(schema.bankImportLines.companyId, ownerCompanyId),
              eq(schema.bankImportLines.batchId, batchId),
              eq(schema.bankImportLines.status, 'STAGED'),
              inArray(schema.bankImportLines.id, rows.map((r) => r.lineId)),
            ),
          )
          .for('share')
      ).map((r) => r.id),
    );
    let saved = 0;
    for (const r of rows) {
      if (!staged.has(r.lineId)) continue;
      await tx
        .insert(schema.bankImportLineDrafts)
        .values({
          lineId: r.lineId,
          companyId,
          action: r.action,
          accountId: r.accountId,
          documentId: r.documentId,
          counterpartCompanyId: r.counterpartCompanyId,
          updatedBy: actorUserId,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [schema.bankImportLineDrafts.lineId, schema.bankImportLineDrafts.companyId],
          set: {
            action: r.action,
            accountId: r.accountId,
            documentId: r.documentId,
            counterpartCompanyId: r.counterpartCompanyId,
            updatedBy: actorUserId,
            updatedAt: sql`now()`,
          },
        });
      saved += 1;
    }
    return saved;
  });
}

/** The cardholder's review screen: save the current per-line choices for `batchId`. */
export async function saveReviewDrafts(
  actorUserId: string,
  companyId: string,
  batchId: string,
  input: SaveReviewDraftsInput,
): Promise<{ saved: number }> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  const batch = (
    await getDb()
      .select({ id: schema.bankImportBatches.id, bankAccountId: schema.bankImportBatches.bankAccountId })
      .from(schema.bankImportBatches)
      .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)))
      .limit(1)
  )[0];
  if (batch === undefined) throw new BankImportError('BATCH_NOT_FOUND', 'Import batch not found.');
  if (input.drafts.length === 0) return { saved: 0 };

  const [pickable, counterparts] = await Promise.all([pickableAccounts(companyId, batch.bankAccountId), transferCounterparts(actorUserId, companyId)]);
  const accountOk = new Set(pickable.map((a) => a.id));
  const counterpartOk = new Set(counterparts.map((c) => c.id));
  const rows: DraftRow[] = input.drafts.map((d) => ({
    lineId: d.lineId,
    action: d.action,
    accountId: d.accountId !== undefined && accountOk.has(d.accountId) ? d.accountId : null,
    documentId: d.documentId ?? null,
    counterpartCompanyId: d.counterpartCompanyId !== undefined && counterpartOk.has(d.counterpartCompanyId) ? d.counterpartCompanyId : null,
  }));
  return { saved: await upsertDrafts(actorUserId, companyId, companyId, batchId, rows) };
}

/** The shared "take" screen: save the viewing company's ticks and account picks for `batchId`. */
export async function saveSharedDrafts(
  actorUserId: string,
  viewerCompanyId: string,
  batchId: string,
  input: SaveSharedDraftsInput,
): Promise<{ saved: number }> {
  await requirePermission(actorUserId, viewerCompanyId, 'journal.post');
  const visible = (await visibleBatches(actorUserId, viewerCompanyId, batchId))[0];
  // Invisible reads as not-found — the same answer as a batch that does not exist (AGENTS §6).
  if (visible === undefined) throw new BankImportError('BATCH_NOT_FOUND', 'Import batch not found.');
  if (input.drafts.length === 0) return { saved: 0 };

  const pickable = await pickableAccounts(viewerCompanyId, visible.bankAccountId);
  const accountOk = new Set(pickable.map((a) => a.id));
  const rows: DraftRow[] = input.drafts.map((d) => ({
    lineId: d.lineId,
    action: d.take ? 'take' : 'skip',
    accountId: d.accountId !== undefined && accountOk.has(d.accountId) ? d.accountId : null,
    documentId: null,
    counterpartCompanyId: null,
  }));
  return { saved: await upsertDrafts(actorUserId, viewerCompanyId, visible.ownerCompanyId, batchId, rows) };
}
