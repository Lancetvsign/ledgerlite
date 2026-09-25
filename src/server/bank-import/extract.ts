import 'server-only';

import { APICallError, generateText, Output, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { GatewayError } from '@ai-sdk/gateway';
import { z } from 'zod';

import { log } from '@/lib/logging';

import { BankImportError } from './errors';
import { normalizeAmount, normalizeExtractedRow } from './normalize';
import { extractPdfText } from './pdf-text';
import { verifyStatementTotals } from './verify';

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
          // LL-109: the statement's printed totals, in the card's sign convention (owed = negative):
          // −1834.50 + 2000.00 − 165.50 = 0.00.
          summary: { beginningBalance: '-1834.50', totalCredits: '2000.00', totalDebits: '165.50', endingBalance: '0.00' },
        }
      : {
          transactions: [
            { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Sales Revenue' },
            { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50', category: 'Office Supplies' },
            { date: '2026-06-05', description: 'MONTHLY RENT PAYMENT', amount: '-2000.00', category: 'Rent' },
          ],
          // 5000.00 + 1500.00 − 2120.50 = 4379.50
          summary: { beginningBalance: '5000.00', totalCredits: '1500.00', totalDebits: '2120.50', endingBalance: '4379.50' },
        },
  );

// ---------------------------------------------------------------------------------------
// AI extractor
// ---------------------------------------------------------------------------------------

/** Default model, overridable per environment (a `provider/model` id routed by the gateway). */
export const DEFAULT_BANK_IMPORT_MODEL = 'anthropic/claude-sonnet-5';

/**
 * What the model is asked to produce. Amounts are STRINGS (a JSON number would lose
 * precision and is forbidden for money — ADR-004); everything is re-validated strictly by
 * `extractedTransactionsSchema` in `stageImport`, so this schema only shapes the request.
 */
const modelOutputSchema = z.object({
  /**
   * LL-109: the statement's OWN printed control figures — read, never computed. Strings; all
   * optional (omit what the statement does not print). Re-validated by `statementSummarySchema`.
   */
  summary: z
    .object({
      beginningBalance: z.string().optional().describe('The beginning / previous / opening balance the statement PRINTS, as a signed decimal string. For a credit card give the balance OWED as a NEGATIVE number.'),
      totalCredits: z.string().optional().describe('The statement\'s printed total of money INTO the account (total deposits / credits / payments received), unsigned. Read it from the summary; never add it up yourself.'),
      totalDebits: z.string().optional().describe('The statement\'s printed total of money OUT of the account (total withdrawals / debits / purchases / fees), unsigned. Read it; never add it up yourself.'),
      endingBalance: z.string().optional().describe('The ending / new / closing balance the statement PRINTS, signed like the beginning balance (a card balance owed is negative).'),
    })
    .optional()
    .describe('The control figures printed on the statement, or omitted when it prints none.'),
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
- summary: also report the statement's OWN printed control figures — beginning balance, total credits (money in), total debits (money out), ending balance — exactly as printed. Never compute them from the lines; omit any the statement does not print. For a credit card, balances OWED are negative and payments received count as credits.
The transactions you return must add up to those totals: beginning balance + total credits − total debits = ending balance. If yours do not, re-read the statement before answering.
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
}

export function createAiExtractor(options: AiExtractorOptions = {}): TransactionExtractor {
  const readText = options.readText ?? extractPdfText;
  const model: LanguageModel = options.model ?? resolveModel();

  return async ({ bytes, context }) => {
    const text = await readText(bytes); // throws SCANNED_PDF / EXTRACTION_FAILED itself
    const contextPrompt = buildContextPrompt(context);

    // One pass, checked against the statement's own totals (LL-109); on a mismatch ONE more
    // pass with the discrepancy — figures only, never the text — fed back. The pass that
    // verifies wins; if neither does, the second is staged and the review shows the gap.
    const first = await callModel(model, SYSTEM_PROMPT, `${contextPrompt}Statement text:\n\n${text}`);
    const checked = verify(first);
    if (checked.status !== 'mismatch') return { ...first, attempts: 1 };
    log.info('bank-import: statement totals mismatch — re-analysing', { stage: 'verify', attempt: 1, ...figures(checked) });
    const feedback = `\n\nYour previous answer did not reconcile to the statement's own totals: ${checked.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name.replace('_', ' ')} — the statement states ${c.expected}, your lines give ${c.actual} (difference ${c.difference})`)
      .join('; ')}. Re-read EVERY line of the statement: look for a line you dropped, merged, split or misread, and for a subtotal you included by mistake. Do not invent lines. Report the printed totals exactly.`;
    const second = await callModel(model, SYSTEM_PROMPT, `${contextPrompt}Statement text:\n\n${text}${feedback}`);
    const rechecked = verify(second);
    log.info('bank-import: re-analysis result', { stage: 'verify', attempt: 2, status: rechecked.status, ...figures(rechecked) });
    return { ...second, attempts: 2 };
  };
}

/** Counts and figures only (§9) — never a description, never the text. */
function figures(v: ReturnType<typeof verifyStatementTotals>): Record<string, string> {
  return Object.fromEntries(v.checks.map((c) => [c.name, c.difference]));
}

/** Normalise and check one model answer; a summary that fails validation counts as not stated. */
function verify(out: ExtractionOutput): ReturnType<typeof verifyStatementTotals> {
  return verifyStatementTotals(out.transactions.map((t) => t.amount), out.summary ?? null);
}

async function callModel(model: LanguageModel, system: string, prompt: string): Promise<ExtractionOutput> {
    let output: z.infer<typeof modelOutputSchema>;
    try {
      const result = await generateText({
        model,
        system,
        prompt,
        output: Output.object({ schema: modelOutputSchema }),
        // No explicit temperature: some models reject one in structured-output mode, and
        // the gateway surfaces that as an opaque internal error.
      });
      output = result.output;
    } catch (error) {
      // No model output, provider message or file text in the error (§9) — the reviewer
      // only needs to know the extraction did not succeed. Operators need to know WHICH
      // stage failed: log the error class and HTTP status only. A provider message is
      // included solely for auth/billing/config statuses, where it names the gateway
      // problem (e.g. "AI Gateway not enabled") and cannot contain statement text.
      // Gateway errors (auth, model-not-found, provider rejections, gateway 5xx) carry the
      // gateway's status and its own message, which names the parameter/model/credential
      // problem and never contains statement text — always log those. For other API
      // errors log the message only on auth/billing/config statuses.
      const gateway = GatewayError.isInstance(error);
      const status = gateway ? error.statusCode : APICallError.isInstance(error) ? error.statusCode : undefined;
      const configProblem = status !== undefined && [401, 402, 403, 404, 429].includes(status);
      log.warn('bank-import: model extraction failed', {
        stage: 'model',
        route: describeExtractionRoute(),
        error: error instanceof Error ? error.name : typeof error,
        statusCode: status,
        ...(gateway ? { gatewayType: error.type } : {}),
        // The provider message is logged only for auth/billing/config statuses (LL-095): a 400
        // validation body could in principle echo part of the prompt.
        ...(configProblem && error instanceof Error ? { providerMessage: error.message.slice(0, 400) } : {}),
        ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.name } : {}),
      });
      throw new BankImportError('EXTRACTION_FAILED', 'The statement could not be extracted. Try again, or a different statement export.');
    }
    log.info('bank-import: model extraction succeeded', { stage: 'model', route: describeExtractionRoute(), rows: output.transactions.length, summary: output.summary !== undefined });
    // Canonicalise the common notations ($1,500.00, (120.50), 06/03/2026) before the strict
    // validator sees them; anything else passes through untouched and is rejected there.
    const transactions = output.transactions.map(normalizeExtractedRow) as ExtractedTransaction[];
    const summary = output.summary === undefined ? undefined : normalizeSummary(output.summary);
    return summary === undefined ? { transactions } : { transactions, summary };
}

/** The four figures through the same notation canonicaliser as the lines; nothing else. */
function normalizeSummary(raw: { beginningBalance?: string | undefined; totalCredits?: string | undefined; totalDebits?: string | undefined; endingBalance?: string | undefined }): StatementSummary {
  const s: { -readonly [K in keyof StatementSummary]: StatementSummary[K] } = {};
  if (raw.beginningBalance !== undefined) s.beginningBalance = normalizeAmount(raw.beginningBalance);
  if (raw.totalCredits !== undefined) s.totalCredits = normalizeAmount(raw.totalCredits).replace(/^-/, '');
  if (raw.totalDebits !== undefined) s.totalDebits = normalizeAmount(raw.totalDebits).replace(/^-/, '');
  if (raw.endingBalance !== undefined) s.endingBalance = normalizeAmount(raw.endingBalance);
  return s;
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

/** A direct Anthropic API key bypasses the gateway entirely (billed on the Anthropic account). */
function anthropicKey(): string | undefined {
  return nonEmpty(process.env.ANTHROPIC_API_KEY);
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
 *   anthropic — ANTHROPIC_API_KEY set: the model is called directly (no gateway, no
 *               gateway tier rules; usage billed on that Anthropic account)
 *   gateway — a Vercel AI Gateway credential (API key or the deployment's OIDC token)
 *   none    — nothing configured; the upload page says so
 */
export function describeExtractionRoute(): ExtractionRoute {
  if (testExtractorEnabled()) return 'test';
  if (anthropicKey() !== undefined) return 'anthropic';
  if (gatewayCredentialPresent()) return 'gateway';
  return 'none';
}

/**
 * The model for this environment. `BANK_IMPORT_MODEL` is a gateway-style `provider/model`
 * id; on the direct-Anthropic route only Anthropic models make sense, so a non-Anthropic
 * override falls back to the default and says so.
 */
function resolveModel(): LanguageModel {
  const configured = nonEmpty(process.env.BANK_IMPORT_MODEL) ?? DEFAULT_BANK_IMPORT_MODEL;
  const key = anthropicKey();
  if (key === undefined) return configured; // a plain string routes through the gateway
  const [provider, ...rest] = configured.split('/');
  const modelId = rest.length === 0 ? configured : rest.join('/');
  if (rest.length > 0 && provider !== 'anthropic') {
    log.warn('bank-import: BANK_IMPORT_MODEL is not an Anthropic model; using the default on the direct route', {
      configured,
      using: DEFAULT_BANK_IMPORT_MODEL,
    });
    return createAnthropic({ apiKey: key })(DEFAULT_BANK_IMPORT_MODEL.replace(/^anthropic\//, ''));
  }
  return createAnthropic({ apiKey: key })(modelId);
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
