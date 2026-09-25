import 'server-only';

import { createHash } from 'node:crypto';

import Decimal from 'decimal.js';

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb, getDbTx, schema } from '@/db';
import { isCategoryPostable } from '@/server/accounts/system-roles';
import { toMoney } from '@/lib/decimal';
import { errorChainText } from '@/lib/error-chain';
import { log } from '@/lib/logging';
import { isStatementAccount } from '@/server/accounts/statement-account';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { listOpenBills, payBillCore, type OpenBill } from '@/server/bill-payments';
import { isIdempotencyViolation, LedgerError, postEntryCore } from '@/server/ledger';
import { listOpenInvoices, receivePaymentCore, type OpenInvoice } from '@/server/payments';
import { getAccountingPeriod } from '@/server/periods';
import { extractedTransactionsSchema, statementSummarySchema } from '@/validation/bank-import';

import { mapCategoryToAccount } from './categorize';
import { draftCountsByBatch, draftsFor, type LineDraft } from './drafts';
import { auditIntercompanyLine, findIntercompanyCandidates, findOrganizationStatementMatches, markIntercompanyTransfer, matchIntercompanyTransfer, statementCounterpartFor, transferCounterparts, type IntercompanyCandidate, type OrganizationMatch } from './intercompany';
import { BankImportError } from './errors';
import { resolveExtractor, toExtractionOutput, type TransactionExtractor } from './extract';
import { summaryOf, verifyStatementTotals, verifyTotals, type StatementVerification } from './verify';

import type { PoolDatabase } from '@/db';
import type { BankImportBatch, BankImportLine } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { AmendImportLineInput, ExtractedTransaction, PostImportLinesInput, StageImportInput } from '@/validation/bank-import';

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
 *                   LL-097: a line may be marked PERSONAL — posted like `post`, to an owner
 *                   equity (or asset) account the reviewer picks — and a CARD statement may be
 *                   SHARED with the organization so another member company takes the lines that
 *                   are its own (see ./shared.ts: status ASSIGNED, one INTERCOMPANY posting on
 *                   each side).
 *
 * Nothing reaches the ledger un-reviewed: staging never posts, and posting requires an
 * explicit per-line decision. `journal.post` (LEDGER_WRITERS) gates every operation;
 * applying additionally requires `payment.create` / `bill_payment.create`.
 */


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

export type PickableAccount = {
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
export async function pickableAccounts(companyId: string, bankAccountId: string): Promise<PickableAccount[]> {
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
    .filter((a) => isCategoryPostable(a.systemAccountType))
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name, accountType: a.accountType }));
}

/**
 * A category suggestion per description from THIS company's precedent and the extractor's
 * category, over this company's pickable accounts (LL-097: the shared view suggests from the
 * taking company's chart, not the cardholder's). Unauthorized; callers authorize.
 */
export async function suggestForCompany(
  companyId: string,
  statementAccountId: string,
  rows: readonly { description: string; aiCategory: string | null }[],
): Promise<{ pickable: PickableAccount[]; suggestions: Map<string, string | null> }> {
  const pickable = await pickableAccounts(companyId, statementAccountId);
  const allowedIds = new Set(pickable.map((a) => a.id));
  const history = await suggestFromHistory(companyId, rows.map((r) => r.description), allowedIds);
  const suggestions = new Map<string, string | null>();
  for (const r of rows) {
    const fromHistory = history.exact.get(normalizeDescription(r.description)) ?? history.payee.get(payeeKey(r.description)) ?? null;
    suggestions.set(r.description, fromHistory ?? mapCategoryToAccount(r.aiCategory ?? undefined, pickable));
  }
  return { pickable, suggestions };
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
      accountSubtype: schema.accounts.accountSubtype,
      cashFlowCategory: schema.accounts.cashFlowCategory,
      systemAccountType: schema.accounts.systemAccountType,
    })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.bankAccountId)))
    .limit(1);
  const bank = bankRows[0];
  // A cash/bank asset or a credit-card liability (LL-088). The posting rule below is the
  // same for both: money IN debits the statement account, money OUT credits it — which for
  // a card means a charge increases what is owed and a payment reduces it.
  if (bank === undefined || !isStatementAccount(bank)) {
    throw new BankImportError('INVALID_BANK_ACCOUNT', 'Choose an active bank account or credit card to import into.');
  }
  const statementKind = bank.accountType === 'LIABILITY' ? 'credit_card' : 'bank';
  const share = input.shareWithOrganization === true;
  if (share) await assertShareable(companyId, statementKind);

  // The model gets the company's chart and its recent decisions (LL-080), so it proposes one
  // of THIS company's accounts and follows the company's precedent.
  const pickable = await pickableAccounts(companyId, input.bankAccountId);
  const allowedIds = new Set(pickable.map((a) => a.id));
  const examples = await historyExamples(companyId);

  // Extract, then validate EVERY row — a single malformed row rejects the batch rather than
  // silently dropping a transaction.
  const raw = await extractor({
    bytes: input.fileBytes,
    context: { accounts: pickable.map((a) => ({ number: a.accountNumber, name: a.name, type: a.accountType })), examples, statementKind },
  });
  const extraction = toExtractionOutput(raw);
  // LL-109: the statement's own control figures. A malformed summary is dropped (logged as a
  // field path), never a reason to reject the rows — the review then reads "not stated".
  const summaryParsed = extraction.summary === undefined ? undefined : statementSummarySchema.safeParse(extraction.summary);
  if (summaryParsed !== undefined && !summaryParsed.success) {
    log.warn('bank-import: statement summary failed validation', { stage: 'validate', path: summaryParsed.error.issues[0]?.path.join('.') });
  }
  const summary = summaryParsed?.success === true ? summaryParsed.data : undefined;
  const parsed = extractedTransactionsSchema.safeParse(extraction.transactions);
  if (!parsed.success) {
    // Field path + rule only — never the offending value (it is statement content, §9).
    const first = parsed.error.issues[0];
    log.warn('bank-import: extracted rows failed validation', { stage: 'validate', rows: extraction.transactions.length, path: first?.path.join('.'), code: first?.code });
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
  const tally = { history: 0, model: 0, unmapped: 0, uncategorised: 0 };
  for (const [i, t] of txns.entries()) {
    const fromHistory =
      history.exact.get(normalizeDescription(t.description)) ?? history.payee.get(payeeKey(t.description)) ?? null;
    const fromModel = fromHistory === null ? mapCategoryToAccount(t.category, pickable) : null;
    const suggested = fromHistory ?? fromModel;
    if (fromHistory !== null) tally.history += 1;
    else if (fromModel !== null) tally.model += 1;
    else if (t.category === undefined || t.category.trim() === '') tally.uncategorised += 1;
    else tally.unmapped += 1;
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

  // Counts only — never a description or category (statement content, §9). `unmapped` is the
  // signal that the model named something the chart mapping could not resolve.
  log.info('bank-import: suggestions', { stage: 'suggest', rows: txns.length, ...tally });
  const verification = verifyStatementTotals(txns.map((t) => t.amount), summary ?? null);
  log.info('bank-import: statement totals', { stage: 'verify', status: verification.status, attempts: extraction.attempts ?? 1, checks: verification.checks.map((c) => `${c.name}:${c.difference}`).join(',') });

  return await getDbTx().transaction(async (tx) => {
    const batchRows = await tx
      .insert(schema.bankImportBatches)
      .values({
        companyId,
        bankAccountId: input.bankAccountId,
        filename: input.filename,
        createdBy: actorUserId,
        sharedWithOrganization: share,
        statedBeginningBalance: summary?.beginningBalance ?? null,
        statedTotalCredits: summary?.totalCredits ?? null,
        statedTotalDebits: summary?.totalDebits ?? null,
        statedEndingBalance: summary?.endingBalance ?? null,
        extractionAttempts: extraction.attempts ?? 1,
      })
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
  /** 'posted' when a POSTED twin exists, 'staged' when only a twin in another (unposted) batch exists (LL-095). */
  readonly duplicateOf: 'posted' | 'staged' | null;
  /** The likely other side of a transfer on another statement account, if any (LL-094). */
  readonly transferCandidate: TransferCandidate | null;
  /** When ASSIGNED (LL-097): the legal name of the organization member that took the line. */
  readonly assignedCompanyName: string | null;
  /** The other company's posted side of an intercompany bank transfer this line mirrors (LL-099). */
  readonly intercompanyCandidate: IntercompanyCandidate | null;
  /** For a POSTED line: the source of its entry — 'INTERCOMPANY' means it can be un-marked (LL-100). */
  readonly postedSource: string | null;
  /** LL-105: this company's saved-but-not-posted choice for a STAGED line, if any. */
  readonly draft: LineDraft | null;
  /** LL-106: the other members' statement lines that mirror this one (nearest first). */
  readonly organizationMatches: readonly OrganizationMatch[];
}

export interface TransferCandidate {
  readonly lineId: string;
  readonly status: 'POSTED' | 'STAGED';
  readonly journalEntryId: string | null;
  /** The OTHER statement account — the category this line would post to. */
  readonly accountId: string;
  readonly txnDate: string;
  readonly batchId: string;
}

const TRANSFER_WINDOW_DAYS = 3;

/**
 * For each staged line, the best candidate mirror on another statement account: same
 * company, opposite amount, within a few days. POSTED candidates first (they can be
 * matched), then the nearest date. One query for the whole set (LL-094).
 */
export async function findTransferCandidates(
  companyId: string,
  bankAccountId: string,
  lineIds: readonly string[],
): Promise<Map<string, TransferCandidate>> {
  const out = new Map<string, TransferCandidate>();
  if (lineIds.length === 0) return out;
  const rows = await getDb().execute<{
    line_id: string; cand_id: string; status: 'POSTED' | 'STAGED'; journal_entry_id: string | null;
    account_id: string; txn_date: string; batch_id: string;
  }>(sql`
    select l.id::text as line_id, c.id::text as cand_id, c.status::text as status,
           c.journal_entry_id::text as journal_entry_id, b.bank_account_id::text as account_id,
           c.txn_date::text as txn_date, c.batch_id::text as batch_id
    from bank_import_lines l
    join bank_import_lines c
      on c.company_id = l.company_id and c.id <> l.id and c.amount = -l.amount
     and c.status in ('POSTED', 'STAGED') and abs(c.txn_date - l.txn_date) <= ${TRANSFER_WINDOW_DAYS}
    join bank_import_batches b
      on b.company_id = c.company_id and b.id = c.batch_id and b.bank_account_id <> ${bankAccountId}
    where l.company_id = ${companyId} and l.id in (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})
    order by l.id, (c.status = 'POSTED') desc, abs(c.txn_date - l.txn_date), c.txn_date, c.id`);
  for (const r of rows.rows) {
    if (!out.has(r.line_id)) {
      out.set(r.line_id, { lineId: r.cand_id, status: r.status, journalEntryId: r.journal_entry_id, accountId: r.account_id, txnDate: r.txn_date, batchId: r.batch_id });
    }
  }
  return out;
}

export interface ImportBatchView {
  readonly batch: BankImportBatch;
  readonly lines: readonly ImportLineView[];
  /** LL-109: the lines that still count (everything but IGNORED) against the statement's printed totals. */
  readonly verification: StatementVerification;
}

/** LL-109: the verdict over the lines that still count — an IGNORED line was never a transaction. */
export function verifyBatch(batch: BankImportBatch, lines: readonly { status: string; amount: string }[]): StatementVerification {
  return verifyStatementTotals(lines.filter((l) => l.status !== 'IGNORED').map((l) => l.amount), summaryOf(batch));
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
        .select({ hash: schema.bankImportLines.dedupHash, id: schema.bankImportLines.id, status: schema.bankImportLines.status, batchId: schema.bankImportLines.batchId })
        .from(schema.bankImportLines)
        .where(
          and(
            eq(schema.bankImportLines.companyId, companyId),
            inArray(schema.bankImportLines.status, ['POSTED', 'PERSONAL', 'ASSIGNED', 'STAGED']),
            inArray(schema.bankImportLines.dedupHash, hashes),
          ),
        );
  const postedByHash = new Map<string, Set<string>>();
  // A STAGED twin counts only from ANOTHER batch: the same statement uploaded twice before
  // either posted (LL-095). Twins inside this batch are two genuine identical transactions.
  const stagedElsewhereByHash = new Map<string, Set<string>>();
  for (const r of dupRows) {
    const target = r.status !== 'STAGED' ? postedByHash : r.batchId !== batchId ? stagedElsewhereByHash : null;
    if (target === null) continue;
    const set = target.get(r.hash) ?? new Set<string>();
    set.add(r.id);
    target.set(r.hash, set);
  }

  const stagedIds = lines.filter((l) => l.status === 'STAGED').map((l) => l.id);
  const candidates = await findTransferCandidates(companyId, batch.bankAccountId, stagedIds);
  const icCandidates = await findIntercompanyCandidates(actorUserId, companyId, lines);
  const drafts = await draftsFor(db, companyId, stagedIds);
  const orgMatches = await findOrganizationStatementMatches(actorUserId, companyId, lines);
  const entryIds = lines.map((l) => l.journalEntryId).filter((id): id is string => id !== null);
  const sourceByEntry = new Map(
    entryIds.length === 0
      ? []
      : (await db.select({ id: schema.journalEntries.id, sourceType: schema.journalEntries.sourceType }).from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), inArray(schema.journalEntries.id, entryIds)))).map((e) => [e.id, e.sourceType as string] as const),
  );
  const assignedIds = [...new Set(lines.map((l) => l.assignedCompanyId).filter((id): id is string => id !== null))];
  const assignedNames = new Map(
    assignedIds.length === 0
      ? []
      : (await db.select({ id: schema.companies.id, legalName: schema.companies.legalName }).from(schema.companies).where(inArray(schema.companies.id, assignedIds))).map((c) => [c.id, c.legalName] as const),
  );

  return {
    batch,
    verification: verifyBatch(batch, lines),
    lines: lines.map((l) => {
      const postedTwin = [...(postedByHash.get(l.dedupHash) ?? [])].some((id) => id !== l.id);
      const duplicateOf = postedTwin ? 'posted' : stagedElsewhereByHash.has(l.dedupHash) ? 'staged' : null;
      return {
        ...l,
        transferCandidate: candidates.get(l.id) ?? null,
        isDuplicate: postedTwin,
        duplicateOf,
        assignedCompanyName: l.assignedCompanyId === null ? null : (assignedNames.get(l.assignedCompanyId) ?? null),
        intercompanyCandidate: icCandidates.get(l.id) ?? null,
        postedSource: l.journalEntryId === null ? null : (sourceByEntry.get(l.journalEntryId) ?? null),
        draft: drafts.get(l.id) ?? null,
        organizationMatches: orgMatches.get(l.id) ?? [],
      };
    }),
  };
}

/** LL-105: where a statement's review stands — derived from its lines and this company's drafts. */
export type ReviewStatus = 'new' | 'in_progress' | 'complete';

export interface ImportBatchSummary extends BankImportBatch {
  readonly stagedCount: number;
  /** Lines that left STAGED (posted, personal, taken, ignored). */
  readonly decidedCount: number;
  readonly draftCount: number;
  readonly reviewStatus: ReviewStatus;
  /** LL-109: whether the lines that count add up to the statement's printed totals. */
  readonly verificationStatus: StatementVerification['status'];
}

export function reviewStatusOf(c: { stagedCount: number; decidedCount: number; draftCount: number }): ReviewStatus {
  if (c.stagedCount === 0) return 'complete';
  if (c.draftCount > 0 || c.decidedCount > 0) return 'in_progress';
  return 'new';
}

/** Recent batches for the upload page, each with its review status (LL-105). */
export async function listImportBatches(actorUserId: string, companyId: string): Promise<ImportBatchSummary[]> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  const db = getDb();
  const batches = await db
    .select()
    .from(schema.bankImportBatches)
    .where(eq(schema.bankImportBatches.companyId, companyId))
    .orderBy(desc(schema.bankImportBatches.createdAt))
    .limit(20);
  if (batches.length === 0) return [];
  const ids = batches.map((b) => b.id);
  const counts = new Map<string, { staged: number; decided: number; credits: string; debits: string }>();
  const rows = await db.execute<{ batch_id: string; staged: string; decided: string; credits: string; debits: string }>(sql`
    select batch_id::text as batch_id,
           count(*) filter (where status = 'STAGED')::text as staged,
           count(*) filter (where status <> 'STAGED')::text as decided,
           coalesce(sum(amount) filter (where status <> 'IGNORED' and amount > 0), 0)::numeric(19,4)::text as credits,
           coalesce(sum(-amount) filter (where status <> 'IGNORED' and amount < 0), 0)::numeric(19,4)::text as debits
    from bank_import_lines
    where company_id = ${companyId} and batch_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    group by batch_id`);
  for (const r of rows.rows) counts.set(r.batch_id, { staged: Number(r.staged), decided: Number(r.decided), credits: r.credits, debits: r.debits });
  const drafts = await draftCountsByBatch(db, companyId, ids);
  return batches.map((b) => {
    const row = counts.get(b.id);
    const c = { stagedCount: row?.staged ?? 0, decidedCount: row?.decided ?? 0, draftCount: drafts.get(b.id) ?? 0 };
    // The database summed the lines that count; the verifier only needs the two sums.
    const verification = verifyTotals(row?.credits ?? '0', row?.debits ?? '0', summaryOf(b));
    return { ...b, ...c, reviewStatus: reviewStatusOf(c), verificationStatus: verification.status };
  });
}

export interface PostImportResult {
  /** Lines that reached the ledger (categorised AND applied). */
  readonly posted: number;
  /** Lines marked posted against an entry the other side of a transfer already created (LL-094). */
  readonly matched: number;
  readonly ignored: number;
  /** The subset of `posted` settled against an open invoice / bill (LL-077). */
  readonly applied: number;
  /** Lines marked PERSONAL — posted to an owner equity/asset account (LL-097). */
  readonly personal: number;
  /** Lines posted as this company's side of an intercompany bank transfer — marked or matched (LL-099). */
  readonly intercompany: number;
}

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/** What one validated decision will do. Built for EVERY decision before ANY line is written. */
type LinePlan =
  | { readonly kind: 'post'; readonly line: BankImportLine; readonly accountId: string; readonly personal: boolean }
  | { readonly kind: 'match'; readonly line: BankImportLine; readonly counterpart: BankImportLine; readonly journalEntryId: string; readonly accountId: string }
  | { readonly kind: 'apply_invoice'; readonly line: BankImportLine; readonly invoice: OpenInvoice; readonly amount: string }
  | { readonly kind: 'apply_bill'; readonly line: BankImportLine; readonly bill: OpenBill; readonly amount: string }
  | { readonly kind: 'ic_mark'; readonly line: BankImportLine; readonly counterpartCompanyId: string }
  | { readonly kind: 'ic_match'; readonly line: BankImportLine; readonly counterpartEntryId: string; readonly counterpartCompanyId: string };

/**
 * Lock the line and report whether it is still STAGED. Concurrent submits of the same line
 * serialise here; the loser sees POSTED/IGNORED and creates nothing. Lock order is always
 * line → document (no other path locks a bank-import line), so no cycle is possible.
 */
export async function lockStagedLine(
  tx: Tx,
  companyId: string,
  lineId: string,
  /**
   * LL-107: the amount the caller planned with. A correction (`amendImportLine`) that landed
   * between the caller's read and this lock would otherwise post the stale figure; the locked
   * row is compared and a change is refused (LINE_CHANGED) rather than silently skipped.
   */
  expectedAmount?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ status: schema.bankImportLines.status, amount: schema.bankImportLines.amount })
    .from(schema.bankImportLines)
    .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, lineId)))
    .for('update')
    .limit(1);
  const row = rows[0];
  if (row?.status !== 'STAGED') return false;
  if (expectedAmount !== undefined && !toMoney(row.amount).eq(toMoney(expectedAmount))) {
    throw new BankImportError('LINE_CHANGED', 'A line was corrected while you were reviewing — reload and try again.');
  }
  return true;
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
  // One lookup, only when an apply decision is present at all (LL-093).
  const isCard = input.decisions.some((d) => d.action === 'apply_invoice' || d.action === 'apply_bill' || d.action === 'intercompany_transfer')
    ? (
        await db
          .select({ accountType: schema.accounts.accountType })
          .from(schema.accounts)
          .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, batch.bankAccountId)))
          .limit(1)
      )[0]?.accountType === 'LIABILITY'
    : false;

  const transferCandidates = await findTransferCandidates(
    companyId,
    batch.bankAccountId,
    input.decisions.filter((d) => d.action === 'post').map((d) => d.lineId),
  );

  // LL-099: the organization members the actor may move money with, and the other side's
  // posted entries offered to this batch's lines — loaded only when a decision needs them.
  const needsIc = input.decisions.some((d) => d.action === 'intercompany_transfer' || d.action === 'match_intercompany');
  const counterparts = needsIc ? await transferCounterparts(actorUserId, companyId) : [];
  const icCandidates = needsIc ? await findIntercompanyCandidates(actorUserId, companyId, lineRows) : new Map<string, IntercompanyCandidate>();

  const plans: LinePlan[] = [];
  const toIgnore: BankImportLine[] = [];
  const matchedEntries = new Set<string>();
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

    // A credit-card statement posts to accounts only: paying a bill or settling an
    // invoice from a card is not modelled (bill payments draw on cash assets) — LL-088.
    // Checked per LIVE decision, after the idempotent skip above (LL-093).
    if (isCard && (d.action === 'apply_invoice' || d.action === 'apply_bill')) {
      throw new BankImportError('CARD_CANNOT_APPLY', 'Credit-card statement lines can only be posted to an account.');
    }
    const n = String(line.lineNumber);

    let plan: LinePlan;
    if (d.action === 'match_transfer') {
      // LL-094: this line is the mirror of a POSTED line on another statement account.
      if (d.counterpartLineId === undefined) {
        throw new BankImportError('TRANSFER_MISMATCH', `Line ${n}: choose the posted transfer to match.`);
      }
      const cpRows = await db
        .select({ line: schema.bankImportLines, bankAccountId: schema.bankImportBatches.bankAccountId })
        .from(schema.bankImportLines)
        .innerJoin(schema.bankImportBatches, and(eq(schema.bankImportBatches.companyId, schema.bankImportLines.companyId), eq(schema.bankImportBatches.id, schema.bankImportLines.batchId)))
        .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, d.counterpartLineId)))
        .limit(1);
      const cp = cpRows[0];
      const mirror = cp !== undefined && cp.line.status === 'POSTED' && cp.line.journalEntryId !== null
        && cp.bankAccountId !== batch.bankAccountId
        && toMoney(cp.line.amount).plus(toMoney(line.amount)).isZero()
        && Math.abs(Date.parse(cp.line.txnDate) - Date.parse(line.txnDate)) <= TRANSFER_WINDOW_DAYS * 86_400_000;
      if (!mirror || cp === undefined || cp.line.journalEntryId === null) {
        throw new BankImportError('TRANSFER_MISMATCH', `Line ${n}: that is not the posted mirror of this transfer.`);
      }
      // The entry must really carry this account's side of the movement.
      const abs = toMoney(line.amount).abs().toFixed(4);
      const side = toMoney(line.amount).isPositive() ? sql`l.debit = ${abs}::numeric` : sql`l.credit = ${abs}::numeric`;
      const proof = await db.execute<{ ok: string }>(sql`
        select count(*)::text as ok from journal_lines l
        where l.company_id = ${companyId} and l.journal_entry_id = ${cp.line.journalEntryId} and l.account_id = ${batch.bankAccountId} and ${side}`);
      if (proof.rows[0]?.ok !== '1') {
        throw new BankImportError('TRANSFER_MISMATCH', `Line ${n}: the posted entry does not move this account by this amount.`);
      }
      plan = { kind: 'match', line, counterpart: cp.line, journalEntryId: cp.line.journalEntryId, accountId: cp.bankAccountId };
    } else if (d.action === 'post') {
      if (d.accountId === undefined) {
        throw new BankImportError('ACCOUNT_REQUIRED', `Line ${n} needs an account to post to.`);
      }
      // LL-094: posting the exact mirror of a transfer the other statement already posted
      // would double-count it — match it instead (or ignore it).
      const cand = transferCandidates.get(line.id);
      if (cand !== undefined && cand.status === 'POSTED' && cand.accountId === d.accountId) {
        throw new BankImportError('TRANSFER_ALREADY_POSTED', `Line ${n}: the other side of this transfer already posted — use "Match transfer".`);
      }
      if (!allowedIds.has(d.accountId)) {
        // Either not this company's active account, or an excluded one (A/R, A/P, OBE, the bank).
        throw new BankImportError(
          'CONTROL_ACCOUNT_NOT_ALLOWED',
          `Line ${n}: choose an active account that is not Accounts Receivable, Accounts Payable, Opening Balance Equity, or the bank account itself.`,
        );
      }
      plan = { kind: 'post', line, accountId: d.accountId, personal: false };
    } else if (d.action === 'personal') {
      // LL-097: not this company's charge — the owner's. Posted like `post`, but only to an
      // equity or asset account (Owner Distributions, or a "due from owner" asset), never an
      // expense, so the P&L never carries it.
      if (d.accountId === undefined) {
        throw new BankImportError('ACCOUNT_REQUIRED', `Line ${n} needs an equity or asset account to mark it personal against.`);
      }
      const target = pickable.find((a) => a.id === d.accountId);
      if (target === undefined) {
        throw new BankImportError('CONTROL_ACCOUNT_NOT_ALLOWED', `Line ${n}: choose an active account that is not a control account or the card itself.`);
      }
      if (target.accountType !== 'EQUITY' && target.accountType !== 'ASSET') {
        throw new BankImportError('ACCOUNT_INVALID', `Line ${n}: a personal charge posts to an owner equity or asset account, not to ${target.name}.`);
      }
      plan = { kind: 'post', line, accountId: d.accountId, personal: true };
    } else if (d.action === 'intercompany_transfer') {
      // LL-099: this company's side of money moved to/from another member company. LL-106: the
      // company is named either by the OTHER company's staged statement line (re-proven from the
      // database — never a guessed id) or, as a last resort, by a company picker.
      if (d.counterpartStatementLineId === undefined && d.counterpartCompanyId === undefined) {
        throw new BankImportError('COUNTERPART_REQUIRED', `Line ${n}: still waiting for the other company's statement — nothing to match yet.`);
      }
      const resolved = d.counterpartStatementLineId === undefined ? null : await statementCounterpartFor(actorUserId, companyId, line, d.counterpartStatementLineId, counterparts);
      if (d.counterpartStatementLineId !== undefined && resolved === null) {
        throw new BankImportError('COUNTERPART_INVALID', `Line ${n}: that statement line is no longer the other side of this movement — check again.`);
      }
      const cp = counterparts.find((c) => c.id === (resolved ?? d.counterpartCompanyId));
      if (cp === undefined) {
        throw new BankImportError('COUNTERPART_INVALID', `Line ${n}: choose a company of your organization you can post in.`);
      }
      // LL-102 (Gate 7 L9): a card CHARGE has no counterpart flow — only a payment or refund
      // on a card statement can be the other side of a bank movement.
      if (isCard && toMoney(line.amount).isNegative()) {
        throw new BankImportError('CARD_CHARGE_NOT_TRANSFER', `Line ${n}: a card charge cannot be an intercompany transfer; share the statement and let the other company take it instead.`);
      }
      plan = { kind: 'ic_mark', line, counterpartCompanyId: cp.id };
    } else if (d.action === 'match_intercompany') {
      const cand = icCandidates.get(line.id);
      if (cand === undefined || cand.entryId !== d.counterpartEntryId) {
        throw new BankImportError('TRANSFER_MISMATCH', `Line ${n}: that is not the other company's side of this transfer.`);
      }
      // Two lines of one submit aimed at one entry fail HERE, before anything posts (LL-101).
      if (matchedEntries.has(cand.entryId)) {
        throw new BankImportError('TRANSFER_ALREADY_MATCHED', `Line ${n}: another line of this submit already matches that transfer.`);
      }
      matchedEntries.add(cand.entryId);
      plan = { kind: 'ic_match', line, counterpartEntryId: cand.entryId, counterpartCompanyId: cand.counterpartCompanyId };
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
  let matched = 0;
  let personal = 0;
  let intercompany = 0;
  for (const plan of plans) {
    const { line } = plan;
    const lineIs = and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, line.id), eq(schema.bankImportLines.status, 'STAGED'));

    if (plan.kind === 'match') {
      // LL-094: no new entry. The line is marked posted against the counterpart's entry so
      // both statements reconcile to the one movement. Exactly one mirror per entry.
      const done = await getDbTx().transaction(async (tx): Promise<boolean> => {
        if (!(await lockStagedLine(tx, companyId, line.id, line.amount))) return false;
        const cpNow = await tx
          .select({ status: schema.bankImportLines.status, journalEntryId: schema.bankImportLines.journalEntryId })
          .from(schema.bankImportLines)
          .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, plan.counterpart.id)))
          .for('update');
        if (cpNow[0]?.status !== 'POSTED' || cpNow[0].journalEntryId !== plan.journalEntryId) {
          throw new BankImportError('TRANSFER_MISMATCH', 'The transfer\'s other side changed; reload and review again.');
        }
        const already = await tx
          .select({ id: schema.bankImportLines.id })
          .from(schema.bankImportLines)
          .where(and(
            eq(schema.bankImportLines.companyId, companyId),
            eq(schema.bankImportLines.journalEntryId, plan.journalEntryId),
            ne(schema.bankImportLines.id, plan.counterpart.id),
            eq(schema.bankImportLines.status, 'POSTED'),
          ))
          .limit(1);
        if (already.length > 0) {
          throw new BankImportError('TRANSFER_ALREADY_POSTED', 'That transfer already has its other side matched.');
        }
        await tx
          .update(schema.bankImportLines)
          .set({ status: 'POSTED', chosenAccountId: plan.accountId, journalEntryId: plan.journalEntryId, mirrorOfLineId: plan.counterpart.id, updatedAt: sql`now()` })
          .where(lineIs);
        await recordAuditEvent({
          tx,
          companyId,
          actorUserId,
          action: 'BANK_IMPORT_POSTED',
          entityType: 'bank_import_line',
          entityId: line.id,
          after: { batchId, accountId: plan.accountId, amount: line.amount, journalEntryId: plan.journalEntryId, matchedTransfer: plan.counterpart.id },
        });
        return true;
      }).catch((error: unknown) => {
        // The structural backstop (LL-095): unique(mirror_of_line_id) — one mirror per counterpart.
        if (/bank_import_lines_mirror_of_line_id_unique/.test(errorChainText(error))) {
          throw new BankImportError('TRANSFER_ALREADY_POSTED', 'That transfer already has its other side matched.');
        }
        throw error;
      });
      if (done) matched += 1;
      continue;
    }

    if (plan.kind === 'ic_mark' || plan.kind === 'ic_match') {
      // LL-099: one INTERCOMPANY posting on this company's pair account against its own bank.
      try {
        const done = await getDbTx().transaction(async (tx): Promise<boolean> => {
          if (!(await lockStagedLine(tx, companyId, line.id, line.amount))) return false;
          const r = plan.kind === 'ic_mark'
            ? await markIntercompanyTransfer(tx, actorUserId, companyId, batch.bankAccountId, line, plan.counterpartCompanyId)
            : await matchIntercompanyTransfer(tx, actorUserId, companyId, batch.bankAccountId, line, plan.counterpartEntryId);
          await tx
            .update(schema.bankImportLines)
            .set({ status: 'POSTED', chosenAccountId: r.accountId, journalEntryId: r.entryId, updatedAt: sql`now()` })
            .where(lineIs);
          await auditIntercompanyLine(tx, companyId, actorUserId, batchId, line, r, plan.kind === 'ic_mark' ? 'marked' : 'matched', plan.counterpartCompanyId);
          return true;
        });
        if (done) intercompany += 1;
      } catch (error) {
        // Our side of this group already exists (a concurrent match) — the group unique says so.
        if (/journal_entries_intercompany_group_company_unique/.test(errorChainText(error))) {
          throw new BankImportError('TRANSFER_ALREADY_MATCHED', 'This company already posted its side of that transfer.');
        }
        if (!isIdempotencyViolation(error)) throw error;
      }
      continue;
    }

    if (plan.kind === 'post') {
      try {
        const done = await getDbTx().transaction(async (tx): Promise<boolean> => {
          if (!(await lockStagedLine(tx, companyId, line.id, line.amount))) return false; // decided concurrently
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
            .set({ status: plan.personal ? 'PERSONAL' : 'POSTED', chosenAccountId: plan.accountId, journalEntryId: entry.entry.id, updatedAt: sql`now()` })
            .where(lineIs);

          await recordAuditEvent({
            tx,
            companyId,
            actorUserId,
            action: 'BANK_IMPORT_POSTED',
            entityType: 'bank_import_line',
            entityId: line.id,
            after: { batchId, accountId: plan.accountId, amount: line.amount, journalEntryId: entry.entry.id, personal: plan.personal },
          });
          return true;
        });
        if (done) {
          // counted only once the transaction has COMMITTED
          if (plan.personal) personal += 1;
          else posted += 1;
        }
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
      if (!(await lockStagedLine(tx, companyId, line.id, line.amount))) return false; // decided concurrently
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

  return { posted, matched, ignored: toIgnore.length, applied, personal, intercompany };
}

export { BankImportError, PeriodClosedInCompanyError } from './errors';
export type { BankImportErrorCode } from './errors';
export { isExtractionConfigured } from './extract';
export type { ExtractionOutput, ExtractionResult, TransactionExtractor } from './extract';
export { verifyStatementTotals, summaryOf } from './verify';
export type { StatementVerification, VerificationCheck, VerificationStatus } from './verify';

/**
 * LL-107 (ADR-046): correct the amount of a STAGED line the extractor misread. The figure it
 * read is kept in `amended_from` from the first correction on; the duplicate hash follows the
 * corrected figure; the correction is audited. Every amount-derived suggestion (transfer,
 * intercompany and organization matches, document amount-matches, duplicates) is recomputed on
 * the next render and re-validated at post, so nothing else needs touching. A decided line is
 * frozen — here (LINE_NOT_EDITABLE) and by trigger (0044).
 */
export async function amendImportLine(
  actorUserId: string,
  companyId: string,
  batchId: string,
  lineId: string,
  input: AmendImportLineInput,
): Promise<{ amended: boolean }> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  return await getDbTx().transaction(async (tx) => {
    const batch = (
      await tx
        .select({ id: schema.bankImportBatches.id, bankAccountId: schema.bankImportBatches.bankAccountId })
        .from(schema.bankImportBatches)
        .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)))
        .limit(1)
    )[0];
    if (batch === undefined) throw new BankImportError('BATCH_NOT_FOUND', 'That import batch does not exist.');
    const line = (
      await tx
        .select()
        .from(schema.bankImportLines)
        .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.batchId, batchId), eq(schema.bankImportLines.id, lineId)))
        .for('update')
        .limit(1)
    )[0];
    if (line === undefined) throw new BankImportError('LINE_NOT_FOUND', 'Import line not found.');
    if (line.status !== 'STAGED') throw new BankImportError('LINE_NOT_EDITABLE', 'That line has already been decided; its amount cannot change.');
    const next = toMoney(input.amount).toFixed(4);
    if (toMoney(line.amount).eq(next)) return { amended: false };
    const amendedFrom = line.amendedFrom ?? line.amount;
    await tx
      .update(schema.bankImportLines)
      .set({
        amount: next,
        dedupHash: dedupHash(batch.bankAccountId, { date: line.txnDate, description: line.description ?? '', amount: next }),
        amendedFrom,
        updatedAt: sql`now()`,
      })
      .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, line.id)));
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BANK_IMPORT_LINE_AMENDED',
      entityType: 'bank_import_line',
      entityId: line.id,
      before: { amount: line.amount },
      after: { amount: next, amendedFrom },
    });
    return { amended: true };
  });
}

/**
 * Deletes an uploaded statement (a batch and its lines) — AUTHORIZED (journal.post) —
 * LL-087 / ADR-042. Allowed ONLY while nothing from it has posted: a batch with a POSTED
 * line is part of the ledger's history and is refused (`BATCH_HAS_POSTINGS`). Until then
 * it is a staging artifact — extracted text and suggestions, no accounting value — and
 * removing a mistaken upload (wrong file, wrong company) is the honest outcome; the
 * ADR-006 "status, never delete" rule is about records, and this is not one yet.
 *
 * Race-safe without relying on locks: lines are deleted only while STAGED or IGNORED (a
 * POSTED, PERSONAL or ASSIGNED line is ledger history — LL-097),
 * and if any line remains the transaction rolls back — a posting that lands between the
 * check and the delete wins.
 */
export async function deleteImportBatch(
  actorUserId: string,
  companyId: string,
  batchId: string,
): Promise<{ lines: number }> {
  await requirePermission(actorUserId, companyId, 'journal.post');

  return await getDbTx().transaction(async (tx) => {
    const batchRows = await tx
      .select({ id: schema.bankImportBatches.id })
      .from(schema.bankImportBatches)
      .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)))
      .for('update');
    if (batchRows[0] === undefined) {
      throw new BankImportError('BATCH_NOT_FOUND', 'That import batch does not exist.');
    }

    const removed = await tx
      .delete(schema.bankImportLines)
      .where(
        and(
          eq(schema.bankImportLines.companyId, companyId),
          eq(schema.bankImportLines.batchId, batchId),
          inArray(schema.bankImportLines.status, ['STAGED', 'IGNORED']),
        ),
      )
      .returning({ id: schema.bankImportLines.id });
    const remaining = await tx
      .select({ id: schema.bankImportLines.id })
      .from(schema.bankImportLines)
      .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.batchId, batchId)))
      .limit(1);
    if (remaining.length > 0) {
      // Rolls the line deletes back: something posted from this batch.
      throw new BankImportError('BATCH_HAS_POSTINGS', 'Lines from this import have been posted; it cannot be deleted.');
    }

    await tx
      .delete(schema.bankImportBatches)
      .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)));
    // Ids and counts only — never statement content (§9).
    log.info('bank-import: batch deleted', { stage: 'delete', companyId, batchId, actorUserId, lines: removed.length });
    return { lines: removed.length };
  });
}

/** Sharing needs an organization and a CARD statement (a shared bank account has no single owner of the cash). */
async function assertShareable(companyId: string, statementKind: 'credit_card' | 'bank'): Promise<void> {
  if (statementKind !== 'credit_card') {
    throw new BankImportError('ONLY_CARDS_SHAREABLE', 'Only a credit-card statement can be shared with the organization.');
  }
  const rows = await getDb()
    .select({ organizationId: schema.companies.organizationId })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  if ((rows[0]?.organizationId ?? null) === null) {
    throw new BankImportError('NOT_IN_ORGANIZATION', 'Put this company in an organization before sharing a statement.');
  }
}

/**
 * Shares (or stops sharing) a card statement with the organization — AUTHORIZED
 * (journal.post) — LL-097. Un-sharing hides the remaining STAGED lines from the other
 * companies; a company that already took lines keeps seeing THOSE (see ./shared.ts), so it
 * can always undo them.
 */
export async function setBatchSharing(
  actorUserId: string,
  companyId: string,
  batchId: string,
  shared: boolean,
): Promise<BankImportBatch> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select({ batch: schema.bankImportBatches, accountType: schema.accounts.accountType })
      .from(schema.bankImportBatches)
      .innerJoin(schema.accounts, and(eq(schema.accounts.companyId, schema.bankImportBatches.companyId), eq(schema.accounts.id, schema.bankImportBatches.bankAccountId)))
      .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)))
      .for('update', { of: schema.bankImportBatches });
    const found = rows[0];
    if (found === undefined) throw new BankImportError('BATCH_NOT_FOUND', 'Import batch not found.');
    if (found.batch.sharedWithOrganization === shared) return found.batch;
    if (shared) await assertShareable(companyId, found.accountType === 'LIABILITY' ? 'credit_card' : 'bank');

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BANK_IMPORT_SHARING_CHANGED',
      entityType: 'bank_import_batch',
      entityId: batchId,
      before: { sharedWithOrganization: found.batch.sharedWithOrganization },
      after: { sharedWithOrganization: shared },
    });
    const updated = await tx
      .update(schema.bankImportBatches)
      .set({ sharedWithOrganization: shared })
      .where(and(eq(schema.bankImportBatches.companyId, companyId), eq(schema.bankImportBatches.id, batchId)))
      .returning();
    const batch = updated[0];
    if (batch === undefined) throw new Error('batch update returned no row');
    return batch;
  });
}

export * from './shared';
export { transferCounterparts, unmarkIntercompanyTransfer } from './intercompany';
export { saveReviewDrafts, saveSharedDrafts } from './drafts';
export type { LineDraft } from './drafts';
export type { IntercompanyCandidate, MemberCompany as TransferCounterpart, OrganizationMatch } from './intercompany';
