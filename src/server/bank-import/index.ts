import 'server-only';

import { createHash } from 'node:crypto';

import Decimal from 'decimal.js';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb, getDbTx, schema } from '@/db';
import { toMoney } from '@/lib/decimal';
import { log } from '@/lib/logging';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { listOpenBills, payBillCore, type OpenBill } from '@/server/bill-payments';
import { isIdempotencyViolation, LedgerError, postEntryCore } from '@/server/ledger';
import { listOpenInvoices, receivePaymentCore, type OpenInvoice } from '@/server/payments';
import { getAccountingPeriod } from '@/server/periods';
import { extractedTransactionsSchema } from '@/validation/bank-import';

import { BankImportError } from './errors';
import { resolveExtractor, type TransactionExtractor } from './extract';

import type { PoolDatabase } from '@/db';
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
 *                   LL-077 (ADR-035): a line may instead be APPLIED to one open invoice
 *                   (money in) or bill (money out). That creates a real customer payment /
 *                   bill payment through the payment services' transaction-aware cores,
 *                   inside the line's own transaction — so A/R and A/P move only via their
 *                   documents and the aging⇔control reconciliation holds automatically.
 *
 * Nothing reaches the ledger un-reviewed: staging never posts, and posting requires an
 * explicit per-line decision. `journal.post` (LEDGER_WRITERS) gates every operation;
 * applying additionally requires `payment.create` / `bill_payment.create`.
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
  accountType: string;
};

/**
 * The "payee key" of a statement description: lower-cased with reference numbers, dates,
 * check numbers and punctuation stripped, so `OFFICE DEPOT #1234` and `OFFICE DEPOT #9876`
 * are the same payee. Mirrors the SQL expression in `suggestFromHistory` exactly.
 */
function payeeKey(d: string): string {
  return d.toLowerCase().replace(/[0-9#*/.:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Map the extractor's free-text category to a chart account by name or number (case-insensitive). */
function mapCategory(category: string | undefined, accounts: readonly PickableAccount[]): string | null {
  if (category === undefined) return null;
  const c = category.trim().toLowerCase();
  if (c === '') return null;
  const hit = accounts.find((a) => a.name.toLowerCase() === c || (a.accountNumber ?? '').toLowerCase() === c);
  return hit?.id ?? null;
}

/**
 * What this company decided before (LL-080): for each statement description, the account it
 * most often POSTED a matching line to — the user's corrections included, because a posted
 * line's `chosen_account_id` is what they confirmed, not what was suggested. Two matches, in
 * priority order: the exact (case-insensitive) description, then the payee key. One query
 * for the whole batch.
 */
interface HistoryMatch {
  readonly exact: Map<string, string>;
  readonly payee: Map<string, string>;
}

async function suggestFromHistory(
  companyId: string,
  descriptions: readonly string[],
  allowedIds: ReadonlySet<string>,
): Promise<HistoryMatch> {
  const exactKeys = [...new Set(descriptions.map(normalizeDescription))];
  const payeeKeys = [...new Set(descriptions.map(payeeKey).filter((k) => k !== ''))];
  const out: HistoryMatch = { exact: new Map(), payee: new Map() };
  if (exactKeys.length === 0) return out;
  // Same character class as payeeKey(): digits, #, *, /, ., :, hyphen (hyphen last — no escaping games).
  const PAYEE_SQL = sql`trim(regexp_replace(regexp_replace(lower(description), '[0-9#*/.:-]+', ' ', 'g'), '\\s+', ' ', 'g'))`;
  const rows = await getDb().execute<{ kind: string; key: string; account_id: string; n: string }>(sql`
    select 'exact' as kind, lower(trim(description)) as key, chosen_account_id::text as account_id, count(*)::text as n
    from bank_import_lines
    where company_id = ${companyId} and status = 'POSTED' and chosen_account_id is not null
      and lower(trim(description)) in (${sql.join(exactKeys.map((k) => sql`${k}`), sql`, `)})
    group by 1, 2, 3
    union all
    select 'payee' as kind, ${PAYEE_SQL} as key, chosen_account_id::text as account_id, count(*)::text as n
    from bank_import_lines
    where company_id = ${companyId} and status = 'POSTED' and chosen_account_id is not null
      and ${PAYEE_SQL} in (${sql.join((payeeKeys.length === 0 ? [''] : payeeKeys).map((k) => sql`${k}`), sql`, `)})
    group by 1, 2, 3
    order by 1, 2, 4 desc, 3`);
  // Rows arrive most-used first per (kind, key); keep the first allowed account for each.
  for (const r of rows.rows) {
    const target = r.kind === 'exact' ? out.exact : out.payee;
    if (!target.has(r.key) && allowedIds.has(r.account_id)) target.set(r.key, r.account_id);
  }
  return out;
}

/** Recent distinct (description → account name) decisions, for the model's examples (LL-080). */
async function historyExamples(companyId: string, limit = 60): Promise<{ description: string; account: string }[]> {
  const rows = await getDb().execute<{ description: string; account: string }>(sql`
    select distinct on (lower(trim(l.description))) l.description, a.name as account
    from bank_import_lines l
    join accounts a on a.company_id = l.company_id and a.id = l.chosen_account_id
    where l.company_id = ${companyId} and l.status = 'POSTED' and l.chosen_account_id is not null and l.description is not null
    order by lower(trim(l.description)), l.updated_at desc
    limit ${limit}`);
  return rows.rows;
}

/** The ACTIVE accounts a line may be categorised to: not control, not OBE, not the bank account. */
async function pickableAccounts(companyId: string, bankAccountId: string): Promise<PickableAccount[]> {
  const rows = await getDb()
    .select({
      id: schema.accounts.id,
      accountNumber: schema.accounts.accountNumber,
      name: schema.accounts.name,
      accountType: schema.accounts.accountType,
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
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name, accountType: a.accountType }));
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

  // The model gets the company's chart and its recent decisions (LL-080), so it proposes one
  // of THIS company's accounts and follows the company's precedent.
  const pickable = await pickableAccounts(companyId, input.bankAccountId);
  const allowedIds = new Set(pickable.map((a) => a.id));
  const examples = await historyExamples(companyId);

  // Extract, then validate EVERY row — a single malformed row rejects the batch rather than
  // silently dropping a transaction.
  const raw = await extractor({
    bytes: input.fileBytes,
    context: { accounts: pickable.map((a) => ({ number: a.accountNumber, name: a.name, type: a.accountType })), examples },
  });
  const parsed = extractedTransactionsSchema.safeParse(raw);
  if (!parsed.success) {
    // Field path + rule only — never the offending value (it is statement content, §9).
    const first = parsed.error.issues[0];
    log.warn('bank-import: extracted rows failed validation', { stage: 'validate', rows: Array.isArray(raw) ? raw.length : -1, path: first?.path.join('.'), code: first?.code });
    throw new BankImportError('EXTRACTION_FAILED', `The extracted statement had a malformed row: ${first?.message ?? 'invalid'}.`);
  }
  const txns = parsed.data;
  if (txns.length === 0) {
    log.warn('bank-import: extractor returned no transactions', { stage: 'validate', rows: 0 });
    throw new BankImportError('EXTRACTION_FAILED', 'No transactions were found in the statement.');
  }

  // Suggest an account per line — history FIRST (it encodes the user's corrections), the
  // exact description before the payee key, then the model's chart pick (LL-080).
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
    const suggested =
      history.exact.get(normalizeDescription(t.description)) ??
      history.payee.get(payeeKey(t.description)) ??
      mapCategory(t.category, pickable) ??
      null;
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
  /** Lines that reached the ledger (categorised AND applied). */
  readonly posted: number;
  readonly ignored: number;
  /** The subset of `posted` settled against an open invoice / bill (LL-077). */
  readonly applied: number;
}

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/** What one validated decision will do. Built for EVERY decision before ANY line is written. */
type LinePlan =
  | { readonly kind: 'post'; readonly line: BankImportLine; readonly accountId: string }
  | { readonly kind: 'apply_invoice'; readonly line: BankImportLine; readonly invoice: OpenInvoice; readonly amount: string }
  | { readonly kind: 'apply_bill'; readonly line: BankImportLine; readonly bill: OpenBill; readonly amount: string };

/**
 * Lock the line and report whether it is still STAGED. Concurrent submits of the same line
 * serialise here; the loser sees POSTED/IGNORED and creates nothing. Lock order is always
 * line → document (no other path locks a bank-import line), so no cycle is possible.
 */
async function lockStagedLine(tx: Tx, companyId: string, lineId: string): Promise<boolean> {
  const rows = await tx
    .select({ status: schema.bankImportLines.status })
    .from(schema.bankImportLines)
    .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, lineId)))
    .for('update')
    .limit(1);
  return rows[0]?.status === 'STAGED';
}

/** The payment fields a bank line implies; the amount is the whole line, never input. */
function paymentFieldsFor(line: BankImportLine): { reference: string | undefined; memo: string; method: string } {
  const ref = line.description?.trim().slice(0, 100) ?? '';
  return {
    reference: ref === '' ? undefined : ref,
    memo: `Bank import line ${String(line.lineNumber)}`,
    method: 'Bank import',
  };
}

export async function postImportLines(
  actorUserId: string,
  companyId: string,
  batchId: string,
  input: PostImportLinesInput,
): Promise<PostImportResult> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  // Applying a line creates a real payment document, so the document capabilities apply
  // too (today every journal.post holder has them; checked explicitly regardless).
  if (input.decisions.some((d) => d.action === 'apply_invoice')) {
    await requirePermission(actorUserId, companyId, 'payment.create');
  }
  if (input.decisions.some((d) => d.action === 'apply_bill')) {
    await requirePermission(actorUserId, companyId, 'bill_payment.create');
  }
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

  // Open documents are loaded only when some decision applies to one (company-scoped lists,
  // so a foreign or closed document is simply absent — one "not open" answer, no leak).
  let openInvoices: Map<string, OpenInvoice> | null = null;
  let openBills: Map<string, OpenBill> | null = null;
  const invoicesById = async (): Promise<Map<string, OpenInvoice>> =>
    (openInvoices ??= new Map((await listOpenInvoices(actorUserId, companyId)).map((i) => [i.id, i])));
  const billsById = async (): Promise<Map<string, OpenBill>> =>
    (openBills ??= new Map((await listOpenBills(actorUserId, companyId)).map((b) => [b.id, b])));

  // Validate EVERY decision before posting ANY, so a bad account, closed period or
  // over-application on one line stops the whole submit up front rather than after some
  // lines have posted.
  const plans: LinePlan[] = [];
  const toIgnore: BankImportLine[] = [];
  const periodOpenByDate = new Map<string, boolean>(); // one lookup per distinct date
  const appliedSoFar = new Map<string, Decimal>(); // documentId → Σ|amount| within THIS submit
  for (const d of input.decisions) {
    const line = byId.get(d.lineId);
    if (line === undefined) throw new BankImportError('LINE_NOT_FOUND', 'Import line not found.');
    if (line.status !== 'STAGED') continue; // already posted or ignored — idempotent no-op
    if (d.action === 'ignore') {
      toIgnore.push(line);
      continue;
    }
    const n = String(line.lineNumber);

    let plan: LinePlan;
    if (d.action === 'post') {
      if (d.accountId === undefined) {
        throw new BankImportError('ACCOUNT_REQUIRED', `Line ${n} needs an account to post to.`);
      }
      if (!allowedIds.has(d.accountId)) {
        // Either not this company's active account, or an excluded one (A/R, A/P, OBE, the bank).
        throw new BankImportError(
          'CONTROL_ACCOUNT_NOT_ALLOWED',
          `Line ${n}: choose an active account that is not Accounts Receivable, Accounts Payable, Opening Balance Equity, or the bank account itself.`,
        );
      }
      plan = { kind: 'post', line, accountId: d.accountId };
    } else {
      // apply_invoice / apply_bill — the whole line settles ONE open document (ADR-035).
      const amt = toMoney(line.amount);
      if (d.documentId === undefined) {
        throw new BankImportError('DOCUMENT_REQUIRED', `Line ${n} needs an open ${d.action === 'apply_invoice' ? 'invoice' : 'bill'} to apply to.`);
      }
      if (d.action === 'apply_invoice' ? !amt.isPositive() : !amt.isNegative()) {
        throw new BankImportError(
          'WRONG_DIRECTION',
          `Line ${n}: money in can only be applied to an invoice, money out only to a bill.`,
        );
      }
      const abs = amt.abs();
      let openBalance: string;
      if (d.action === 'apply_invoice') {
        const invoice = (await invoicesById()).get(d.documentId);
        if (invoice === undefined) throw new BankImportError('DOCUMENT_NOT_OPEN', `Line ${n}: that invoice is not open.`);
        openBalance = invoice.openBalance;
        plan = { kind: 'apply_invoice', line, invoice, amount: abs.toFixed(4) };
      } else {
        const bill = (await billsById()).get(d.documentId);
        if (bill === undefined) throw new BankImportError('DOCUMENT_NOT_OPEN', `Line ${n}: that bill is not open.`);
        openBalance = bill.openBalance;
        plan = { kind: 'apply_bill', line, bill, amount: abs.toFixed(4) };
      }
      // Cumulative within the submit: two lines aimed at one document fail HERE, not after
      // the first has posted. The core re-checks under lock; this is the up-front gate.
      const cumulative = (appliedSoFar.get(d.documentId) ?? new Decimal(0)).plus(abs);
      if (cumulative.greaterThan(toMoney(openBalance))) {
        throw new BankImportError(
          'OVERAPPLIED',
          `Line ${n}: applying ${cumulative.toFixed(4)} exceeds the document's open balance ${toMoney(openBalance).toFixed(4)}.`,
        );
      }
      appliedSoFar.set(d.documentId, cumulative);
    }

    let open = periodOpenByDate.get(line.txnDate);
    if (open === undefined) {
      open = (await getAccountingPeriod(companyId, line.txnDate)).status === 'OPEN';
      periodOpenByDate.set(line.txnDate, open);
    }
    if (!open) {
      throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${line.txnDate} is closed.`);
    }
    plans.push(plan);
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
  let applied = 0;
  for (const plan of plans) {
    const { line } = plan;
    const lineIs = and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, line.id), eq(schema.bankImportLines.status, 'STAGED'));

    if (plan.kind === 'post') {
      try {
        const done = await getDbTx().transaction(async (tx): Promise<boolean> => {
          if (!(await lockStagedLine(tx, companyId, line.id))) return false; // decided concurrently
          const amt = toMoney(line.amount);
          const abs = amt.abs().toFixed(4);
          // money in (+): Dr bank / Cr category ; money out (−): Cr bank / Dr category
          const ledgerLines: PostJournalEntryInput['lines'] = amt.isPositive()
            ? [
                { accountId: batch.bankAccountId, debit: abs, credit: '0' },
                { accountId: plan.accountId, debit: '0', credit: abs },
              ]
            : [
                { accountId: batch.bankAccountId, debit: '0', credit: abs },
                { accountId: plan.accountId, debit: abs, credit: '0' },
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
            .set({ status: 'POSTED', chosenAccountId: plan.accountId, journalEntryId: entry.entry.id, updatedAt: sql`now()` })
            .where(lineIs);

          await recordAuditEvent({
            tx,
            companyId,
            actorUserId,
            action: 'BANK_IMPORT_POSTED',
            entityType: 'bank_import_line',
            entityId: line.id,
            after: { batchId, accountId: plan.accountId, amount: line.amount, journalEntryId: entry.entry.id },
          });
          return true;
        });
        if (done) posted += 1; // counted only once the transaction has COMMITTED
      } catch (error) {
        // A concurrent submit already posted this line (source-once index) — treat as done.
        if (!isIdempotencyViolation(error)) throw error;
      }
      continue;
    }

    // apply_invoice / apply_bill: a REAL customer payment / bill payment, created inside this
    // line's transaction by the payment services' cores, so the payment and the line's POSTED
    // flip commit together — a line can never be applied twice or left half-done. Never a
    // BANK_IMPORT entry touching A/R or A/P (ADR-016/018/023/035).
    const done = await getDbTx().transaction(async (tx): Promise<boolean> => {
      if (!(await lockStagedLine(tx, companyId, line.id))) return false; // decided concurrently
      const fields = paymentFieldsFor(line);
      if (plan.kind === 'apply_invoice') {
        const { result, journalEntryId } = await receivePaymentCore(
          tx,
          actorUserId,
          companyId,
          {
            customerId: plan.invoice.customerId,
            paymentDate: line.txnDate,
            depositAccountId: batch.bankAccountId,
            ...fields,
            applications: [{ invoiceId: plan.invoice.id, amountApplied: plan.amount }],
          },
          undefined,
        );
        await tx
          .update(schema.bankImportLines)
          .set({ status: 'POSTED', paymentId: result.payment.id, journalEntryId, updatedAt: sql`now()` })
          .where(lineIs);
        await recordAuditEvent({
          tx,
          companyId,
          actorUserId,
          action: 'BANK_IMPORT_POSTED',
          entityType: 'bank_import_line',
          entityId: line.id,
          after: { batchId, paymentId: result.payment.id, invoiceId: plan.invoice.id, amount: line.amount, journalEntryId },
        });
      } else {
        const { result, journalEntryId } = await payBillCore(
          tx,
          actorUserId,
          companyId,
          {
            vendorId: plan.bill.vendorId,
            paymentDate: line.txnDate,
            cashAccountId: batch.bankAccountId,
            ...fields,
            applications: [{ billId: plan.bill.id, amountApplied: plan.amount }],
          },
          undefined,
        );
        await tx
          .update(schema.bankImportLines)
          .set({ status: 'POSTED', billPaymentId: result.payment.id, journalEntryId, updatedAt: sql`now()` })
          .where(lineIs);
        await recordAuditEvent({
          tx,
          companyId,
          actorUserId,
          action: 'BANK_IMPORT_POSTED',
          entityType: 'bank_import_line',
          entityId: line.id,
          after: { batchId, billPaymentId: result.payment.id, billId: plan.bill.id, amount: line.amount, journalEntryId },
        });
      }
      return true;
    });
    if (done) {
      posted += 1;
      applied += 1;
    }
  }

  return { posted, ignored: toIgnore.length, applied };
}

export { BankImportError } from './errors';
export type { BankImportErrorCode } from './errors';
export { isExtractionConfigured } from './extract';
export type { TransactionExtractor } from './extract';
