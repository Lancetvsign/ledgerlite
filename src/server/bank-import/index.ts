import 'server-only';

import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb, getDbTx, schema } from '@/db';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { isIdempotencyViolation, LedgerError, postEntryCore } from '@/server/ledger';
import { getAccountingPeriod } from '@/server/periods';
import { extractedTransactionsSchema } from '@/validation/bank-import';

import { BankImportError } from './errors';
import { resolveExtractor, type TransactionExtractor } from './extract';

import type { BankImportBatch, BankImportLine } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { ExtractedTransaction, PostImportLinesInput, StageImportInput } from '@/validation/bank-import';

/**
 * Bank-statement import service — LL-076.
 *
 *   stageImport   → extract (via the injected/production extractor) → validate → suggest an
 *                   account per line (extractor's category mapped to the chart, else history
 *                   of what this company confirmed before) → stage as STAGED lines.
 *   getImportBatch → the batch + lines for the review screen, with duplicate flags.
 *   postImportLines → each confirmed line posts ONE categorised journal entry through
 *                   LedgerService (`postEntryCore`, source_type BANK_IMPORT, sourceId = line
 *                   id, so the source-once index makes a line post at most once):
 *                     money in  (+): Dr bank / Cr category
 *                     money out (−): Cr bank / Dr category
 *                   A/R, A/P, Opening Balance Equity and the bank account itself are never
 *                   valid categories (the control lock only guards JOURNAL_ENTRY, so this
 *                   exclusion is enforced HERE, as opening balances does).
 *
 * Nothing reaches the ledger un-reviewed: staging never posts, and posting requires an
 * explicit per-line decision. `journal.post` (LEDGER_WRITERS) gates every operation.
 */

/** Accounts a bank-import line may never be categorised to. */
const EXCLUDED_SYSTEM_TYPES = new Set(['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'OPENING_BALANCE_EQUITY']);

function normalizeDescription(d: string): string {
  return d.trim().toLowerCase();
}

/**
 * Duplicate-detection key: the same bank account, date, amount and description. The amount
 * is normalised to NUMERIC(19,4) form so '1500', '1500.0' and '1500.00' hash identically.
 */
function dedupHash(bankAccountId: string, t: ExtractedTransaction): string {
  return createHash('sha256')
    .update(`${bankAccountId}|${t.date}|${toMoney(t.amount).toFixed(4)}|${normalizeDescription(t.description)}`)
    .digest('hex');
}

type PickableAccount = {
  id: string;
  accountNumber: string | null;
  name: string;
};

/** Map the extractor's free-text category to a chart account by name or number (case-insensitive). */
function mapCategory(category: string | undefined, accounts: readonly PickableAccount[]): string | null {
  if (category === undefined) return null;
  const c = category.trim().toLowerCase();
  if (c === '') return null;
  const hit = accounts.find((a) => a.name.toLowerCase() === c || (a.accountNumber ?? '').toLowerCase() === c);
  return hit?.id ?? null;
}

/**
 * History fallback: for each statement description, the account this company most often
 * confirmed for it before (over POSTED bank-import lines). Exact, case-insensitive
 * description match — bank descriptions for a recurring payee are usually identical
 * strings. One query for the whole batch; returns normalised description → account id.
 */
async function suggestFromHistory(
  companyId: string,
  descriptions: readonly string[],
  allowedIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const keys = [...new Set(descriptions.map(normalizeDescription))];
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const rows = await getDb().execute<{ key: string; account_id: string; n: string }>(sql`
    select lower(trim(description)) as key, chosen_account_id::text as account_id, count(*)::text as n
    from bank_import_lines
    where company_id = ${companyId}
      and status = 'POSTED'
      and chosen_account_id is not null
      and lower(trim(description)) in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
    group by 1, 2
    order by 1, count(*) desc, 2`);
  // Rows arrive most-used first per key; keep the first allowed account for each.
  for (const r of rows.rows) {
    if (!out.has(r.key) && allowedIds.has(r.account_id)) out.set(r.key, r.account_id);
  }
  return out;
}

/** The ACTIVE accounts a line may be categorised to: not control, not OBE, not the bank account. */
async function pickableAccounts(companyId: string, bankAccountId: string): Promise<PickableAccount[]> {
  const rows = await getDb()
    .select({
      id: schema.accounts.id,
      accountNumber: schema.accounts.accountNumber,
      name: schema.accounts.name,
      systemAccountType: schema.accounts.systemAccountType,
    })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.status, 'ACTIVE')))
    // Deterministic order so a category that matches two same-named accounts always maps
    // to the same one (lowest number, then name, then id).
    .orderBy(schema.accounts.accountNumber, schema.accounts.name, schema.accounts.id);
  return rows
    .filter((a) => a.id !== bankAccountId)
    .filter((a) => a.systemAccountType === null || !EXCLUDED_SYSTEM_TYPES.has(a.systemAccountType))
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name }));
}

export async function stageImport(
  actorUserId: string,
  companyId: string,
  input: StageImportInput,
  extractor: TransactionExtractor = resolveExtractor(),
): Promise<BankImportBatch> {
  await requirePermission(actorUserId, companyId, 'journal.post');

  // The bank account must be this company's ACTIVE asset cash account.
  const bankRows = await getDb()
    .select({
      id: schema.accounts.id,
      status: schema.accounts.status,
      accountType: schema.accounts.accountType,
      cashFlowCategory: schema.accounts.cashFlowCategory,
    })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.bankAccountId)))
    .limit(1);
  const bank = bankRows[0];
  if (bank === undefined || bank.status !== 'ACTIVE' || bank.accountType !== 'ASSET' || bank.cashFlowCategory !== 'CASH') {
    throw new BankImportError('INVALID_BANK_ACCOUNT', 'Choose an active cash/bank asset account to import into.');
  }

  // Extract, then validate EVERY row — a single malformed row rejects the batch rather than
  // silently dropping a transaction.
  const raw = await extractor({ bytes: input.fileBytes });
  const parsed = extractedTransactionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BankImportError('EXTRACTION_FAILED', `The extracted statement had a malformed row: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
  }
  const txns = parsed.data;
  if (txns.length === 0) {
    throw new BankImportError('EXTRACTION_FAILED', 'No transactions were found in the statement.');
  }

  const pickable = await pickableAccounts(companyId, input.bankAccountId);
  const allowedIds = new Set(pickable.map((a) => a.id));

  // Suggest an account per line: the extractor's category mapped to the chart, else history.
  type StagedLine = {
    lineNumber: number;
    txnDate: string;
    description: string;
    amount: string;
    aiCategory: string | null;
    suggestedAccountId: string | null;
    dedupHash: string;
  };
  const staged: StagedLine[] = [];
  const history = await suggestFromHistory(companyId, txns.map((t) => t.description), allowedIds);
  for (const [i, t] of txns.entries()) {
    const suggested = mapCategory(t.category, pickable) ?? history.get(normalizeDescription(t.description)) ?? null;
    staged.push({
      lineNumber: i + 1,
      txnDate: t.date,
      description: t.description,
      amount: t.amount,
      aiCategory: t.category ?? null,
      suggestedAccountId: suggested,
      dedupHash: dedupHash(input.bankAccountId, t),
    });
  }

  return await getDbTx().transaction(async (tx) => {
    const batchRows = await tx
      .insert(schema.bankImportBatches)
      .values({ companyId, bankAccountId: input.bankAccountId, filename: input.filename, createdBy: actorUserId })
      .returning();
    const batch = batchRows[0];
    if (batch === undefined) throw new Error('bank import batch insert returned no row');

    await tx.insert(schema.bankImportLines).values(
      staged.map((s) => ({ ...s, batchId: batch.id, companyId })),
    );
    return batch;
  });
}

export interface ImportLineView extends BankImportLine {
  /** Another POSTED bank-import line in this company has the same dedup hash. */
  readonly isDuplicate: boolean;
}

export interface ImportBatchView {
  readonly batch: BankImportBatch;
  readonly lines: readonly ImportLineView[];
}

/** The batch + its lines for review, or null for an unknown/other-company batch (no existence leak). */
export async function getImportBatch(
  actorUserId: string,
  companyId: string,
  batchId: string,
): Promise<ImportBatchView | null> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  const db = getDb();

  const batchRows = await db
    .select()
    .from(schema.bankImportBatches)
    .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)))
    .limit(1);
  const batch = batchRows[0];
  if (batch === undefined) return null;

  const lines = await db
    .select()
    .from(schema.bankImportLines)
    .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.batchId, batchId)))
    .orderBy(schema.bankImportLines.lineNumber);

  // A line is a possible duplicate if some OTHER line (any batch) with the same hash already posted.
  const hashes = [...new Set(lines.map((l) => l.dedupHash))];
  const dupRows = hashes.length === 0
    ? []
    : await db
        .select({ hash: schema.bankImportLines.dedupHash, id: schema.bankImportLines.id })
        .from(schema.bankImportLines)
        .where(
          and(
            eq(schema.bankImportLines.companyId, companyId),
            eq(schema.bankImportLines.status, 'POSTED'),
            inArray(schema.bankImportLines.dedupHash, hashes),
          ),
        );
  const postedByHash = new Map<string, Set<string>>();
  for (const r of dupRows) {
    const set = postedByHash.get(r.hash) ?? new Set<string>();
    set.add(r.id);
    postedByHash.set(r.hash, set);
  }

  return {
    batch,
    lines: lines.map((l) => ({
      ...l,
      isDuplicate: [...(postedByHash.get(l.dedupHash) ?? [])].some((id) => id !== l.id),
    })),
  };
}

/** Recent batches for the upload page. */
export async function listImportBatches(actorUserId: string, companyId: string): Promise<BankImportBatch[]> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  return await getDb()
    .select()
    .from(schema.bankImportBatches)
    .where(eq(schema.bankImportBatches.companyId, companyId))
    .orderBy(desc(schema.bankImportBatches.createdAt))
    .limit(20);
}

export interface PostImportResult {
  readonly posted: number;
  readonly ignored: number;
}

export async function postImportLines(
  actorUserId: string,
  companyId: string,
  batchId: string,
  input: PostImportLinesInput,
): Promise<PostImportResult> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  const db = getDb();

  const batchRows = await db
    .select()
    .from(schema.bankImportBatches)
    .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)))
    .limit(1);
  const batch = batchRows[0];
  if (batch === undefined) throw new BankImportError('BATCH_NOT_FOUND', 'Import batch not found.');

  const lineRows = await db
    .select()
    .from(schema.bankImportLines)
    .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.batchId, batchId)));
  const byId = new Map(lineRows.map((l) => [l.id, l]));

  const pickable = await pickableAccounts(companyId, batch.bankAccountId);
  const allowedIds = new Set(pickable.map((a) => a.id));

  // Validate EVERY decision before posting ANY, so a bad account or closed period on one
  // line stops the whole submit up front rather than after some lines have posted.
  const toPost: { line: BankImportLine; accountId: string }[] = [];
  const toIgnore: BankImportLine[] = [];
  const periodOpenByDate = new Map<string, boolean>(); // one lookup per distinct date
  for (const d of input.decisions) {
    const line = byId.get(d.lineId);
    if (line === undefined) throw new BankImportError('LINE_NOT_FOUND', 'Import line not found.');
    if (line.status !== 'STAGED') continue; // already posted or ignored — idempotent no-op
    if (d.action === 'ignore') {
      toIgnore.push(line);
      continue;
    }
    if (d.accountId === undefined) {
      throw new BankImportError('ACCOUNT_REQUIRED', `Line ${String(line.lineNumber)} needs an account to post to.`);
    }
    if (!allowedIds.has(d.accountId)) {
      // Either not this company's active account, or an excluded one (A/R, A/P, OBE, the bank).
      throw new BankImportError(
        'CONTROL_ACCOUNT_NOT_ALLOWED',
        `Line ${String(line.lineNumber)}: choose an active account that is not Accounts Receivable, Accounts Payable, Opening Balance Equity, or the bank account itself.`,
      );
    }
    let open = periodOpenByDate.get(line.txnDate);
    if (open === undefined) {
      open = (await getAccountingPeriod(companyId, line.txnDate)).status === 'OPEN';
      periodOpenByDate.set(line.txnDate, open);
    }
    if (!open) {
      throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${line.txnDate} is closed.`);
    }
    toPost.push({ line, accountId: d.accountId });
  }
  // If every decision targets a line that is already POSTED/IGNORED (a double-submit or a
  // retry), this is a successful no-op — invariant 6: retries are idempotent, not errors.

  for (const line of toIgnore) {
    await getDbTx()
      .update(schema.bankImportLines)
      .set({ status: 'IGNORED', updatedAt: sql`now()` })
      .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, line.id), eq(schema.bankImportLines.status, 'STAGED')));
  }

  let posted = 0;
  for (const { line, accountId } of toPost) {
    try {
      await getDbTx().transaction(async (tx) => {
        const amt = toMoney(line.amount);
        const abs = amt.abs().toFixed(4);
        // money in (+): Dr bank / Cr category ; money out (−): Cr bank / Dr category
        const ledgerLines: PostJournalEntryInput['lines'] = amt.isPositive()
          ? [
              { accountId: batch.bankAccountId, debit: abs, credit: '0' },
              { accountId, debit: '0', credit: abs },
            ]
          : [
              { accountId: batch.bankAccountId, debit: '0', credit: abs },
              { accountId, debit: abs, credit: '0' },
            ];
        const ledgerInput: PostJournalEntryInput = {
          companyId,
          actorUserId,
          transactionDate: line.txnDate,
          postingDate: line.txnDate,
          description: line.description ?? `Bank import line ${String(line.lineNumber)}`,
          sourceType: 'BANK_IMPORT',
          sourceId: line.id,
          lines: ledgerLines,
        };
        const entry = await postEntryCore(tx, ledgerInput, line.txnDate, undefined);

        await tx
          .update(schema.bankImportLines)
          .set({ status: 'POSTED', chosenAccountId: accountId, journalEntryId: entry.entry.id, updatedAt: sql`now()` })
          .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, line.id), eq(schema.bankImportLines.status, 'STAGED')));

        await recordAuditEvent({
          tx,
          companyId,
          actorUserId,
          action: 'BANK_IMPORT_POSTED',
          entityType: 'bank_import_line',
          entityId: line.id,
          after: { batchId, accountId, amount: line.amount, journalEntryId: entry.entry.id },
        });
      });
      posted += 1;
    } catch (error) {
      // A concurrent submit already posted this line (source-once index) — treat as done.
      if (!isIdempotencyViolation(error)) throw error;
    }
  }

  return { posted, ignored: toIgnore.length };
}

export { BankImportError } from './errors';
export type { BankImportErrorCode } from './errors';
export { isExtractionConfigured } from './extract';
export type { TransactionExtractor } from './extract';
