import 'server-only';

import { APICallError, generateText, Output, RetryError, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { GatewayError } from '@ai-sdk/gateway';
import { z } from 'zod';

import { log } from '@/lib/logging';

import { BankImportError, type BankImportErrorCode } from './errors';
import { normalizeDate, normalizeExtractedRow } from './normalize';
import { extractPdfText } from './pdf-text';
import { readSummaryFigures, type RawFigure, type StatementFigure } from './summary-figures';
import { verifyStatementTotals } from './verify';

import { extractedTransactionsSchema, statementSummarySchema } from '@/validation/bank-import';

import type { ExtractedTransaction, StatementSummary } from '@/validation/bank-import';

/**
 * The transaction-extraction seam — LL-076.
 *
 * `stageImport` takes an extractor so the pipeline (staging, review, posting) is exercised
 * deterministically in tests without any external model. An extractor receives the
 * uploaded file's BYTES and owns everything up to a list of candidate transactions:
 *
 *   - `aiExtractor` (LL-076b, the production default when the AI Gateway is reachable):
 *     read the PDF's text layer locally (reject scans), send the TEXT — never the binary —
 *     to a model through Vercel AI Gateway with a strict structured-output schema. The
 *     result is untrusted: `stageImport` re-validates every row, and nothing posts without
 *     human review (ADR-034).
 *   - `notConfiguredExtractor`: when no gateway credential is present, the upload surface
 *     honestly reports "not configured" rather than guess.
 *   - `cannedExtractor`: a fixed synthetic statement, selected ONLY when
 *     `BANK_IMPORT_TEST_EXTRACTOR=1` (e2e / dev). Never enabled in production. A real
 *     model is non-deterministic and needs a credential, so it is never exercised in CI.
 *
 * §9 data handling: the statement text is processed by an external model (the documented
 * ADR-034 exception). The prompt and the model's response are never logged, and no error
 * surfaced to the user or a log carries model output or file contents.
 *
 * The statement text is UNTRUSTED input to the model — a payee memo can carry text that
 * reads like instructions. Strict re-validation limits the shape of what comes back, and the
 * mandatory per-line human review is the backstop against a fabricated or altered row; that
 * is why nothing posts un-reviewed.
 */
/** One chart account the model may categorise to (LL-080). */
export interface ChartAccountHint {
  readonly number: string | null;
  readonly name: string;
  readonly type: string;
}

/** A past decision — the account this company posted a similar description to (LL-080). */
export interface HistoryExample {
  readonly description: string;
  readonly account: string;
}

/**
 * What the extractor knows about the company (LL-080): its pickable chart and its recent
 * decisions, so the model proposes one of THESE accounts rather than a free-text category
 * and follows the company's own precedent. Names/descriptions only — never amounts, never
 * account ids (§9: the least that lets the model do the job).
 */
export interface ExtractionContext {
  readonly accounts: readonly ChartAccountHint[];
  readonly examples: readonly HistoryExample[];
  /**
   * What kind of statement this is (LL-088). A credit-card statement lists purchases as
   * positive numbers, but for the import account they are money OUT; the prompt says so.
   */
  readonly statementKind?: 'bank' | 'credit_card';
}

export interface ExtractorInput {
  /** The uploaded file, in memory. Never persisted. */
  readonly bytes: Uint8Array;
  readonly context?: ExtractionContext;
}

/**
 * LL-109: an extractor may return the rows alone (every test extractor does) or the rows with
 * the statement's own control figures and how many model passes it took.
 */
export interface ExtractionOutput {
  readonly transactions: ExtractedTransaction[];
  readonly summary?: StatementSummary;
  readonly attempts?: number;
  /** LL-118: the re-check (second pass) failed with this code, so the first pass was kept (LL-114). */
  readonly reanalysisFailure?: ModelFailureCode;
  /** LL-123: every account-summary line as read, with its printed label, role and whether it is on the statement. */
  readonly figures?: readonly StatementFigure[];
}
export type ExtractionResult = ExtractedTransaction[] | ExtractionOutput;
export type TransactionExtractor = (input: ExtractorInput) => Promise<ExtractionResult>;

/** Rows-only or rows-with-summary → one shape. */
export function toExtractionOutput(raw: ExtractionResult): ExtractionOutput {
  return Array.isArray(raw) ? { transactions: raw } : raw;
}

export const notConfiguredExtractor: TransactionExtractor = () => {
  throw new BankImportError(
    'EXTRACTION_NOT_CONFIGURED',
    'Statement extraction is not configured: no AI Gateway credential is available in this environment.',
  );
};

/**
 * Synthetic, deterministic statement lines (money in is positive, out is negative). The
 * categories name standard-chart accounts so the category→account mapping is exercised.
 */
export const cannedExtractor: TransactionExtractor = (input) =>
  Promise.resolve(
    input.context?.statementKind === 'credit_card'
      ? {
          // A card statement (LL-088/094): two purchases and the payment that mirrors the
          // bank statement's "MONTHLY RENT PAYMENT" −2000 when that line is categorised to the card.
          transactions: [
            { date: '2026-06-02', description: 'OFFICE DEPOT #1234', amount: '-120.50', category: 'Office Supplies' },
            { date: '2026-06-04', description: 'SHELL FUEL', amount: '-45.00', category: 'Travel & Meals' },
            { date: '2026-06-05', description: 'PAYMENT - THANK YOU', amount: '2000.00' },
          ],
          // LL-109/111: the statement's printed figures, in the import account's convention (a balance owed
          // is negative). A fresh card: 0.00 + 2000.00 − 165.50 = 1834.50 paid ahead — so a fresh company's
          // reconciliation of this statement ties to the cent once its lines are posted.
          summary: { beginningBalance: '0.00', totalCredits: '2000.00', totalDebits: '165.50', endingBalance: '1834.50', statementDate: '2026-06-30' },
          // LL-123: the account-summary lines as a real reading reports them (label, role, found).
          figures: [
            { label: 'Previous Balance', amount: '0.00', role: 'beginning', source: 'label', found: true },
            { label: 'Payments, Credits', amount: '2000.00', role: 'money_in', source: 'label', found: true },
            { label: 'Purchases', amount: '165.50', role: 'money_out', source: 'label', found: true },
            { label: 'New Balance', amount: '1834.50', role: 'ending', source: 'label', found: true },
          ],
        }
      : {
          transactions: [
            { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Sales Revenue' },
            { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50', category: 'Office Supplies' },
            { date: '2026-06-05', description: 'MONTHLY RENT PAYMENT', amount: '-2000.00', category: 'Rent' },
          ],
          // A fresh bank account: 0.00 + 1500.00 − 2120.50 = −620.50 (LL-111: ties a fresh company's reconciliation).
          summary: { beginningBalance: '0.00', totalCredits: '1500.00', totalDebits: '2120.50', endingBalance: '-620.50', statementDate: '2026-06-30' },
          figures: [
            { label: 'Beginning Balance', amount: '0.00', role: 'beginning', source: 'label', found: true },
            { label: 'Total Deposits', amount: '1500.00', role: 'money_in', source: 'label', found: true },
            { label: 'Total Withdrawals', amount: '2120.50', role: 'money_out', source: 'label', found: true },
            { label: 'Ending Balance', amount: '-620.50', role: 'ending', source: 'label', found: true },
          ],
        },
  );

// ---------------------------------------------------------------------------------------
// AI extractor
// ---------------------------------------------------------------------------------------

/** Default model, overridable per environment (a `provider/model` id routed by the gateway). LL-128: was `anthropic/claude-sonnet-5`. */
export const DEFAULT_BANK_IMPORT_MODEL = 'openai/gpt-5.6-sol';

/**
 * What the model is asked to produce. Amounts are STRINGS (a JSON number would lose
 * precision and is forbidden for money — ADR-004); everything is re-validated strictly by
 * `extractedTransactionsSchema` in `stageImport`, so this schema only shapes the request.
 */
const modelOutputSchema = z.object({
  /**
   * LL-109 / LL-123: the statement's OWN account summary — every line of it, each with its label
   * EXACTLY as printed. The app decides each line's role from its label wherever it can and checks
   * that every label and amount is on the statement (summary-figures.ts); the model's role is used
   * only for a label that does not say.
   */
  summary: z
    .object({
      figures: z
        .array(
          z.object({
            label: z.string().describe('The summary line\'s label exactly as printed, e.g. "Previous Balance", "Total Deposits", "Total Checks and Debits", "Balance This Statement".'),
            amount: z.string().describe('The amount exactly as printed on that line, as a string (e.g. "3,814.15").'),
            role: z.enum(['beginning', 'ending', 'money_in', 'money_out']).optional().describe('What the line is: the beginning (previous) balance, the ending (new) balance, a total of money IN, or a total of money OUT.'),
          }),
        )
        .describe('EVERY line of the account summary: the beginning and ending balances and every total of money in and money out (deposits, interest, other credits; checks, withdrawals, card purchases, fees). Never compute a figure; never add lines together.'),
      statementDate: z.string().optional().describe('The statement\'s closing date as printed (statement date / period end / closing date), YYYY-MM-DD. Read it; never infer it from the transaction dates.'),
    })
    .optional()
    .describe('The account summary printed on the statement, or omitted when it prints none.'),
  transactions: z.array(
    z.object({
      date: z.string().describe('Transaction date as YYYY-MM-DD. Use the statement year if a line shows only month/day.'),
      description: z.string().describe('The payee / memo text exactly as printed on the statement line.'),
      amount: z
        .string()
        .describe('Signed decimal as a string, e.g. "1500.00" for money INTO the account (deposit/credit) and "-120.50" for money OUT (withdrawal/debit/payment). Never zero.'),
      category: z
        .string()
        .optional()
        .describe('The account this line belongs to, chosen ONLY from the chart of accounts provided: give that account\'s number or its exact name. Omit if none fits.'),
    }),
  ),
});

const SYSTEM_PROMPT = `You extract the transaction list from the text of a bank statement for double-entry bookkeeping.
Rules:
- Output ONLY transactions that appear on the statement. Never invent, merge, split or round a line.
- Exclude opening/closing balance lines, subtotals, running-balance columns, interest-rate notices and page headers/footers.
- amount is a signed decimal STRING with up to 4 decimal places: positive for money coming INTO the account (deposits, credits, refunds), negative for money going OUT (withdrawals, debits, checks, fees, payments).
- date is YYYY-MM-DD. Infer the year from the statement period when a line shows only the month and day.
- description is the statement's own text for the line, trimmed.
- category is the account for the line, chosen ONLY from the company's chart of accounts given below (answer with the account number or its exact name). Follow the company's past decisions when a description matches one. Omit it rather than guess.
- summary: also copy the statement's account summary — EVERY line of it, each with its label exactly as printed and its amount exactly as printed: the beginning (previous) balance, every total of money in (deposits, interest, other credits), every total of money out (checks, withdrawals, card purchases, fees), and the ending balance — plus the statement's closing date. Copy; never compute, add up or re-label a figure. Give the amounts as printed (no sign changes).
If the text contains no transactions, return an empty list.`;

const MAX_CHART_ACCOUNTS = 300;
const MAX_HISTORY_EXAMPLES = 60;

/** The company-specific part of the prompt: its chart and its precedent (LL-080). */
export function buildContextPrompt(context: ExtractionContext | undefined): string {
  if (context === undefined) return '';
  const accounts = context.accounts.slice(0, MAX_CHART_ACCOUNTS)
    .map((a) => `- ${a.number !== null && a.number !== '' ? `${a.number} ` : ''}${a.name} (${a.type})`)
    .join('\n');
  const examples = context.examples.slice(0, MAX_HISTORY_EXAMPLES)
    .map((e) => `- "${e.description}" → ${e.account}`)
    .join('\n');
  const kind =
    context.statementKind === 'credit_card'
      ? 'This is a CREDIT CARD statement. For the amount sign, the account is the card: purchases, charges, fees and interest are money OUT (negative amounts); payments received, refunds and credits are money IN (positive amounts), whatever sign the statement prints.\n\n'
      : '';
  return (
    kind +
    (accounts === '' ? '' : `Chart of accounts (choose category from these only):\n${accounts}\n\n`) +
    (examples === '' ? '' : `The company's past decisions (statement description → account). Match these first:\n${examples}\n\n`)
  );
}

export interface AiExtractorOptions {
  /** The model to call; defaults to `BANK_IMPORT_MODEL` or `DEFAULT_BANK_IMPORT_MODEL` through the gateway. */
  readonly model?: LanguageModel;
  /** PDF → text; injectable so unit tests need neither a PDF nor pdf.js. */
  readonly readText?: (bytes: Uint8Array) => Promise<string>;
  /** Total time the model calls may take (default `EXTRACTION_TIME_BUDGET_MS`); injectable for tests. */
  readonly budgetMs?: number;
  /** The least time that must remain for the re-check to start (default `MIN_RECHECK_MS`). */
  readonly minRecheckMs?: number;
}

/**
 * LL-127: the upload runs inside one 300 s serverless request (`maxDuration` on the upload page).
 * The model calls get 240 s between them; the rest is for categorising, the staging transaction and
 * the redirect. Past it the call is aborted and reported (EXTRACTION_TIMED_OUT) instead of the
 * platform killing the request and showing the reviewer a crash page.
 */
export const EXTRACTION_TIME_BUDGET_MS = 240_000;
/** A re-check that cannot have at least this long is not started — the first pass is staged instead. */
export const MIN_RECHECK_MS = 60_000;

export function createAiExtractor(options: AiExtractorOptions = {}): TransactionExtractor {
  const readText = options.readText ?? extractPdfText;
  const model: LanguageModel = options.model ?? resolveModel();
  const budgetMs = options.budgetMs ?? EXTRACTION_TIME_BUDGET_MS;
  const minRecheckMs = options.minRecheckMs ?? MIN_RECHECK_MS;

  return async ({ bytes, context }) => {
    const startedAt = Date.now();
    const remaining = (): number => budgetMs - (Date.now() - startedAt);
    const text = await readText(bytes); // throws SCANNED_PDF / EXTRACTION_FAILED itself
    const contextPrompt = buildContextPrompt(context);
    const kind = context?.statementKind ?? 'bank';

    // One pass, checked against the statement's own figures (LL-109, LL-123); when they do not hold
    // — the summary's own math is off, a balance is missing, a figure is not on the statement, or the
    // lines do not add up — ONE more pass with the discrepancy fed back as figures. The pass that
    // verifies wins; if neither does, the second is staged and the review shows the gap.
    // LL-114: the second pass is an attempt to improve a sound first answer, never a condition
    // of it — if it fails (the AI service refused or was unreachable, or answered unusably),
    // the first pass is staged and the review shows its gap, rather than losing the upload.
    // LL-127: each call is bounded by what is left of the time budget; a re-check that cannot have
    // `minRecheckMs` is not started, and one that is cut off falls back to the first pass the same way.
    const first = withFigures(await callModel(model, SYSTEM_PROMPT, `${contextPrompt}Statement text:\n\n${text}`, remaining()), text, kind);
    const checked = verify(first);
    const problems = summaryProblems(first, checked);
    if (problems.length === 0) return { ...first, attempts: 1 };
    log.info('bank-import: statement figures do not hold — re-analysing', { stage: 'verify', attempt: 1, ...figures(checked), ...figureCounts(first) });
    if (remaining() < minRecheckMs) {
      log.warn('bank-import: no time left for a re-analysis — staging the first pass', { stage: 'verify', attempt: 2, outcome: 'EXTRACTION_TIMED_OUT', remainingMs: Math.max(0, remaining()) });
      return { ...first, attempts: 1, reanalysisFailure: 'EXTRACTION_TIMED_OUT' };
    }
    const feedback = `\n\nYour previous answer did not hold together: ${problems.join(' ')} Re-read the statement: copy EVERY line of its account summary with its label and amount exactly as printed, and EVERY transaction line (look for a line you dropped, merged, split or misread, and for a subtotal you included by mistake). Do not invent lines or figures.`;
    let second: ExtractionOutput;
    try {
      second = withFigures(await callModel(model, SYSTEM_PROMPT, `${contextPrompt}Statement text:\n\n${text}${feedback}`, remaining()), text, kind);
    } catch (error) {
      if (!(error instanceof BankImportError)) throw error;
      // callModel has already logged the failure (stage, status, outcome); say what happens next.
      log.warn('bank-import: re-analysis failed — staging the first pass', { stage: 'verify', attempt: 2, outcome: error.code });
      return { ...first, attempts: 1, reanalysisFailure: isModelFailureCode(error.code) ? error.code : 'EXTRACTION_FAILED' };
    }
    const rechecked = verify(second);
    log.info('bank-import: re-analysis result', { stage: 'verify', attempt: 2, status: rechecked.status, ...figures(rechecked), ...figureCounts(second) });
    return { ...second, attempts: 2 };
  };
}

/**
 * LL-123: why an answer's figures do not hold, as sentences for the re-read (figures and the
 * statement's own labels only — the model already has the statement text). Empty = they hold.
 */
function summaryProblems(out: ExtractionOutput, checked: ReturnType<typeof verifyStatementTotals>): string[] {
  const problems: string[] = [];
  const s = out.summary;
  // Every statement prints a beginning and an ending balance (the owner, 2026-09-28): an answer with
  // no account summary at all is asked for it once.
  if (out.figures === undefined) problems.push('The statement\'s account summary is missing from your answer: copy its beginning (previous) balance, every total of money in and money out, and its ending balance.');
  if (out.figures !== undefined) {
    if (s?.beginningBalance === undefined) problems.push('The beginning (previous) balance is missing from the account summary you gave.');
    if (s?.endingBalance === undefined) problems.push('The ending balance is missing from the account summary you gave.');
    const missing = out.figures.filter((f) => !f.found);
    if (missing.length > 0) problems.push(`These summary figures are not on the statement as you gave them: ${missing.map((f) => `"${f.label}" ${f.amount}`).join(', ')}.`);
  }
  for (const c of checked.checks.filter((x) => !x.ok)) {
    problems.push(
      c.name === 'statement_math'
        ? `The summary does not add up: beginning ${s?.beginningBalance ?? '?'} + money in ${s?.totalCredits ?? '?'} − money out ${s?.totalDebits ?? '?'} = ${c.actual}, but the ending balance is ${c.expected} (off by ${c.difference}) — a summary line is probably missing, e.g. interest or other credits, or fees.`
        : `${c.name.replace('_', ' ')}: the statement states ${c.expected}, your lines give ${c.actual} (difference ${c.difference}).`,
    );
  }
  return problems;
}

/** Counts only (§9). */
function figureCounts(out: ExtractionOutput): Record<string, number> {
  return { figures: out.figures?.length ?? 0, notFound: out.figures?.filter((f) => !f.found).length ?? 0 };
}

/** Counts and figures only (§9) — never a description, never the text. */
function figures(v: ReturnType<typeof verifyStatementTotals>): Record<string, string> {
  return Object.fromEntries(v.checks.map((c) => [c.name, c.difference]));
}

/**
 * Check one model answer against its own summary. Only well-formed figures are compared: a row
 * or a summary the strict validator would reject is left for `stageImport` to report (a
 * malformed row rejects the batch there; a malformed summary reads as not stated) — the
 * verifier itself must never throw on model output.
 */
function verify(out: ExtractionOutput): ReturnType<typeof verifyStatementTotals> {
  const rows = extractedTransactionsSchema.safeParse(out.transactions);
  const summary = out.summary === undefined ? undefined : statementSummarySchema.safeParse(out.summary);
  if (!rows.success || (summary !== undefined && !summary.success)) {
    return verifyStatementTotals([], null); // not_stated: nothing sound to check yet
  }
  return verifyStatementTotals(rows.data.map((t) => t.amount), summary?.data ?? null);
}

/** The HTTP status an AI SDK / gateway error carries, if any. */
function statusOf(error: unknown): number | undefined {
  if (GatewayError.isInstance(error)) return error.statusCode;
  if (APICallError.isInstance(error)) return error.statusCode;
  return undefined;
}

/**
 * Provider refusals that mean "no money on the account", whatever status they come with
 * (Anthropic answers 400 "Your credit balance is too low…"; OpenAI-style providers 429
 * "insufficient_quota"). Deliberately specific phrases: a 400 body can echo prompt text, and a
 * statement may well say "billing".
 */
// LL-128: the AI Gateway's free tier refuses paid models with a 403 "Free tier users do not have access to this model" — a credit problem, not a key problem.
const CREDIT_REFUSAL = /credit balance is too low|insufficient_quota|exceeded your current quota|free tier users do not have access/i;

export type ModelFailureCode = Extract<
  BankImportErrorCode,
  | 'EXTRACTION_FAILED'
  | 'EXTRACTION_KEY_REJECTED'
  | 'EXTRACTION_OUT_OF_CREDIT'
  | 'EXTRACTION_MODEL_UNAVAILABLE'
  | 'EXTRACTION_RATE_LIMITED'
  | 'EXTRACTION_SERVICE_UNAVAILABLE'
  | 'EXTRACTION_TIMED_OUT'
>;

/** LL-118: every model-failure code, in one place — the database CHECK on `reanalysis_failure` lists the same seven. */
export const MODEL_FAILURE_CODES: readonly ModelFailureCode[] = [
  'EXTRACTION_FAILED',
  'EXTRACTION_KEY_REJECTED',
  'EXTRACTION_OUT_OF_CREDIT',
  'EXTRACTION_MODEL_UNAVAILABLE',
  'EXTRACTION_RATE_LIMITED',
  'EXTRACTION_SERVICE_UNAVAILABLE',
  'EXTRACTION_TIMED_OUT',
];

export function isModelFailureCode(value: unknown): value is ModelFailureCode {
  return typeof value === 'string' && (MODEL_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * LL-113: which side a failed model call was — the AI SERVICE (credential, credit, model, rate
 * limit, outage) or the STATEMENT (anything else, EXTRACTION_FAILED as before). Only the status and
 * the error class decide; the provider's message is consulted solely for the credit refusal, and
 * never leaves this function. A retried failure is judged by its last attempt.
 */
export function classifyModelFailure(thrown: unknown): ModelFailureCode {
  const error = RetryError.isInstance(thrown) ? thrown.lastError : thrown;
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : '';
  if (status === 402 || ((status === 400 || status === 403 || status === 429) && CREDIT_REFUSAL.test(message))) return 'EXTRACTION_OUT_OF_CREDIT';
  if (status === 401 || status === 403) return 'EXTRACTION_KEY_REJECTED';
  if (status === 404) return 'EXTRACTION_MODEL_UNAVAILABLE';
  if (status === 429) return 'EXTRACTION_RATE_LIMITED';
  if (status !== undefined && status >= 500) return 'EXTRACTION_SERVICE_UNAVAILABLE';
  // No response at all (network failure, timeout): the service was unreachable.
  if (status === undefined && APICallError.isInstance(error) && error.isRetryable) return 'EXTRACTION_SERVICE_UNAVAILABLE';
  return 'EXTRACTION_FAILED';
}

/** The error's own message per outcome — no provider text, no statement text (§9). */
const MODEL_FAILURE_MESSAGE: Record<ModelFailureCode, string> = {
  EXTRACTION_FAILED: 'The statement could not be extracted. Try again, or a different statement export.',
  EXTRACTION_KEY_REJECTED: 'The AI service rejected this application\'s API key.',
  EXTRACTION_OUT_OF_CREDIT: 'The AI service account is out of credit.',
  EXTRACTION_MODEL_UNAVAILABLE: 'The configured AI model was not found.',
  EXTRACTION_RATE_LIMITED: 'The AI service is rate-limiting requests.',
  EXTRACTION_SERVICE_UNAVAILABLE: 'The AI service is unavailable.',
  EXTRACTION_TIMED_OUT: 'The AI took too long reading the statement.',
};

/**
 * LL-127: models that take an `effort` setting (Sonnet 5 and later, Opus 4.5+, Fable 5, Sonnet 4.6).
 * Haiku 4.5 and Sonnet 4.5 reject it with a 400, so it is sent only where it is accepted.
 */
const EFFORT_MODELS = /claude-(sonnet-5|sonnet-4-6|opus-4-[5-8]|opus-5|fable-5)/;

/**
 * LL-128: OpenAI reasoning models (gpt-5.x / gpt-6 / the o-series) take `reasoningEffort`; older chat models
 * (gpt-4o …) reject it with a 400, so it is sent only where it is accepted.
 */
const OPENAI_REASONING_MODELS = /^openai\/(gpt-[56]|o[1-9])/;

function modelIdOf(model: LanguageModel): string {
  return typeof model === 'string' ? model : model.modelId;
}

/**
 * Per-provider request options for reading a statement (LL-127 effort, LL-128 OpenAI). Keyed by the provider's
 * own name, which the gateway forwards. OpenAI is also told NOT to force strict JSON-schema mode: strict mode
 * requires every property to be required, and this request schema has optional ones (summary, category, role).
 */
function providerOptionsFor(modelId: string): { providerOptions?: Record<string, Record<string, string | boolean>> } {
  if (EFFORT_MODELS.test(modelId)) return { providerOptions: { anthropic: { effort: 'low' } } };
  if (modelId.startsWith('openai/')) {
    return { providerOptions: { openai: { strictJsonSchema: false, ...(OPENAI_REASONING_MODELS.test(modelId) ? { reasoningEffort: 'low' } : {}) } } };
  }
  return {};
}

async function callModel(model: LanguageModel, system: string, prompt: string, timeoutMs: number): Promise<ModelAnswer> {
    let output: z.infer<typeof modelOutputSchema>;
    let outputTokens: number | undefined;
    // LL-127: bounded by the caller's time budget — an aborted call is reported, not left to the platform's kill.
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
    const startedAt = Date.now();
    try {
      const result = await generateText({
        model,
        system,
        prompt,
        output: Output.object({ schema: modelOutputSchema }),
        abortSignal: signal,
        // LL-127: reading a statement is transcription, not reasoning. The default effort ran a 44-row
        // statement for over four minutes; low effort keeps the same model and finishes far sooner.
        ...providerOptionsFor(modelIdOf(model)),
        // No explicit temperature: some models reject one in structured-output mode, and
        // the gateway surfaces that as an opaque internal error.
      });
      output = result.output;
      outputTokens = result.usage.outputTokens;
    } catch (thrown) {
      if (signal.aborted) {
        log.warn('bank-import: model extraction timed out', { stage: 'model', route: describeExtractionRoute(), outcome: 'EXTRACTION_TIMED_OUT', ms: Date.now() - startedAt });
        throw new BankImportError('EXTRACTION_TIMED_OUT', MODEL_FAILURE_MESSAGE.EXTRACTION_TIMED_OUT);
      }
      // No model output, provider message or file text in the error (§9) — the reviewer
      // only needs to know the extraction did not succeed, and (LL-113) whether that was the
      // statement or the AI service. Operators need to know WHICH stage failed: log the error
      // class and HTTP status only. A provider message is included solely for
      // auth/billing/config statuses, where it names the gateway problem (e.g. "AI Gateway not
      // enabled") and cannot contain statement text. A retried failure (429 / 5xx) arrives
      // wrapped in a RetryError; its last attempt is what is classified and logged.
      const error = RetryError.isInstance(thrown) ? thrown.lastError : thrown;
      const gateway = GatewayError.isInstance(error);
      const status = statusOf(error);
      const configProblem = status !== undefined && [401, 402, 403, 404, 429].includes(status);
      const outcome = classifyModelFailure(thrown);
      log.warn('bank-import: model extraction failed', {
        stage: 'model',
        route: describeExtractionRoute(),
        outcome,
        error: error instanceof Error ? error.name : typeof error,
        statusCode: status,
        ...(RetryError.isInstance(thrown) ? { attempts: thrown.errors.length } : {}),
        ...(gateway ? { gatewayType: error.type } : {}),
        // The provider message is logged only for auth/billing/config statuses (LL-095): a 400
        // validation body could in principle echo part of the prompt.
        ...(configProblem && error instanceof Error ? { providerMessage: error.message.slice(0, 400) } : {}),
        ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.name } : {}),
      });
      throw new BankImportError(outcome, MODEL_FAILURE_MESSAGE[outcome]);
    }
    log.info('bank-import: model extraction succeeded', { stage: 'model', route: describeExtractionRoute(), rows: output.transactions.length, summary: output.summary !== undefined, figures: output.summary?.figures.length ?? 0, ms: Date.now() - startedAt, outputTokens });
    // Canonicalise the common notations ($1,500.00, (120.50), 06/03/2026) before the strict
    // validator sees them; anything else passes through untouched and is rejected there.
    const transactions = output.transactions.map(normalizeExtractedRow) as ExtractedTransaction[];
    if (output.summary === undefined) return { transactions };
    return {
      transactions,
      rawFigures: output.summary.figures,
      ...(output.summary.statementDate === undefined ? {} : { statementDate: normalizeDate(output.summary.statementDate) }),
    };
}

/** One model answer before its summary lines are read against the statement (LL-123). */
interface ModelAnswer {
  readonly transactions: ExtractedTransaction[];
  readonly rawFigures?: readonly RawFigure[];
  readonly statementDate?: string;
}

/**
 * LL-123: the answer's summary lines read against the statement text — roles from the printed
 * labels, every figure checked to be on the statement — into the four totals the app uses.
 */
function withFigures(answer: ModelAnswer, text: string, statementKind: 'bank' | 'credit_card'): ExtractionOutput {
  if (answer.rawFigures === undefined) return { transactions: answer.transactions };
  const { summary, figures } = readSummaryFigures(answer.rawFigures, text, statementKind);
  const withDate: StatementSummary = answer.statementDate === undefined ? summary : { ...summary, statementDate: answer.statementDate };
  return { transactions: answer.transactions, summary: withDate, figures };
}

// ---------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------

function testExtractorEnabled(): boolean {
  return process.env.BANK_IMPORT_TEST_EXTRACTOR === '1';
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t === undefined || t === '' ? undefined : t;
}

/** A direct Anthropic API key bypasses the gateway — for an Anthropic model only (LL-128). */
function anthropicKey(): string | undefined {
  return nonEmpty(process.env.ANTHROPIC_API_KEY);
}

/** The configured `provider/model` id: `BANK_IMPORT_MODEL`, else the default. */
function configuredModelId(): string {
  return nonEmpty(process.env.BANK_IMPORT_MODEL) ?? DEFAULT_BANK_IMPORT_MODEL;
}

function isAnthropicModelId(id: string): boolean {
  return id.startsWith('anthropic/') || id.startsWith('claude-');
}

/**
 * The gateway authenticates with `AI_GATEWAY_API_KEY` (local / non-Vercel) or a Vercel
 * OIDC token (present automatically on Vercel deployments).
 */
function gatewayCredentialPresent(): boolean {
  if (nonEmpty(process.env.AI_GATEWAY_API_KEY) !== undefined) return true;
  if (nonEmpty(process.env.VERCEL_OIDC_TOKEN) !== undefined) return true;
  return process.env.VERCEL === '1';
}

export type ExtractionRoute = 'test' | 'anthropic' | 'gateway' | 'none';

/**
 * Which way statement extraction will go in this environment, in priority order:
 *   test    — BANK_IMPORT_TEST_EXTRACTOR=1 (canned statement; e2e/dev only)
 *   anthropic — the configured model is an Anthropic one AND ANTHROPIC_API_KEY is set: called directly
 *               (no gateway, no gateway tier rules; usage billed on that Anthropic account)
 *   gateway — a Vercel AI Gateway credential (API key or the deployment's OIDC token): any other model,
 *               e.g. the default `openai/gpt-5.6-sol` (LL-128)
 *   none    — nothing configured; the upload page says so
 * LL-128: the MODEL decides — an `ANTHROPIC_API_KEY` left in place no longer captures a non-Anthropic model.
 */
export function describeExtractionRoute(): ExtractionRoute {
  if (testExtractorEnabled()) return 'test';
  if (anthropicKey() !== undefined && isAnthropicModelId(configuredModelId())) return 'anthropic';
  if (gatewayCredentialPresent()) return 'gateway';
  return 'none';
}

/**
 * The model for this environment. `BANK_IMPORT_MODEL` is a gateway-style `provider/model` id; a plain
 * string routes through the gateway, and on the direct-Anthropic route the id is handed to `@ai-sdk/anthropic`.
 */
function resolveModel(): LanguageModel {
  const configured = configuredModelId();
  if (describeExtractionRoute() !== 'anthropic') return configured;
  return createAnthropic({ apiKey: anthropicKey() ?? '' })(configured.replace(/^anthropic\//, ''));
}

/** Whether an extractor is available (drives the upload page's "not configured" state). */
export function isExtractionConfigured(): boolean {
  return describeExtractionRoute() !== 'none';
}

/** The extractor for this environment. */
export function resolveExtractor(): TransactionExtractor {
  const route = describeExtractionRoute();
  if (route === 'test') return cannedExtractor;
  if (route === 'none') return notConfiguredExtractor;
  return createAiExtractor();
}
