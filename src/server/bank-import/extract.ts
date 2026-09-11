import 'server-only';

import { APICallError, generateText, Output, type LanguageModel } from 'ai';
import { GatewayError } from '@ai-sdk/gateway';
import { z } from 'zod';

import { log } from '@/lib/logging';

import { BankImportError } from './errors';
import { normalizeExtractedRow } from './normalize';
import { extractPdfText } from './pdf-text';

import type { ExtractedTransaction } from '@/validation/bank-import';

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
export interface ExtractorInput {
  /** The uploaded file, in memory. Never persisted. */
  readonly bytes: Uint8Array;
}

export type TransactionExtractor = (input: ExtractorInput) => Promise<ExtractedTransaction[]>;

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
export const cannedExtractor: TransactionExtractor = () =>
  Promise.resolve([
    { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Sales Revenue' },
    { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50', category: 'Office Supplies' },
    { date: '2026-06-05', description: 'MONTHLY RENT PAYMENT', amount: '-2000.00', category: 'Rent' },
  ]);

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
        .describe('A short bookkeeping category for this line, e.g. "Sales Revenue", "Office Supplies", "Rent", "Utilities", "Bank Fees", "Owner Contribution". Omit if unsure.'),
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
- category is a short suggested bookkeeping category; omit it rather than guess wildly.
If the text contains no transactions, return an empty list.`;

export interface AiExtractorOptions {
  /** The model to call; defaults to `BANK_IMPORT_MODEL` or `DEFAULT_BANK_IMPORT_MODEL` through the gateway. */
  readonly model?: LanguageModel;
  /** PDF → text; injectable so unit tests need neither a PDF nor pdf.js. */
  readonly readText?: (bytes: Uint8Array) => Promise<string>;
}

export function createAiExtractor(options: AiExtractorOptions = {}): TransactionExtractor {
  const readText = options.readText ?? extractPdfText;
  const configured = process.env.BANK_IMPORT_MODEL?.trim();
  const model: LanguageModel = options.model ?? (configured !== undefined && configured !== '' ? configured : DEFAULT_BANK_IMPORT_MODEL);

  return async ({ bytes }) => {
    const text = await readText(bytes); // throws SCANNED_PDF / EXTRACTION_FAILED itself

    let output: z.infer<typeof modelOutputSchema>;
    try {
      const result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: `Statement text:\n\n${text}`,
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
        error: error instanceof Error ? error.name : typeof error,
        statusCode: status,
        ...(gateway ? { gatewayType: error.type } : {}),
        ...((gateway || configProblem) && error instanceof Error ? { providerMessage: error.message.slice(0, 400) } : {}),
        ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.name } : {}),
      });
      throw new BankImportError('EXTRACTION_FAILED', 'The statement could not be extracted. Try again, or a different statement export.');
    }
    log.info('bank-import: model extraction succeeded', { stage: 'model', rows: output.transactions.length });
    // Canonicalise the common notations ($1,500.00, (120.50), 06/03/2026) before the strict
    // validator sees them; anything else passes through untouched and is rejected there.
    return output.transactions.map(normalizeExtractedRow);
  };
}

// ---------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------

function testExtractorEnabled(): boolean {
  return process.env.BANK_IMPORT_TEST_EXTRACTOR === '1';
}

/**
 * The gateway authenticates with `AI_GATEWAY_API_KEY` (local / non-Vercel) or a Vercel
 * OIDC token (present automatically on Vercel deployments).
 */
function gatewayCredentialPresent(): boolean {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (key !== undefined && key !== '') return true;
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  if (oidc !== undefined && oidc !== '') return true;
  return process.env.VERCEL === '1';
}

/** Whether an extractor is available (drives the upload page's "not configured" state). */
export function isExtractionConfigured(): boolean {
  return testExtractorEnabled() || gatewayCredentialPresent();
}

/** The extractor for this environment. */
export function resolveExtractor(): TransactionExtractor {
  if (testExtractorEnabled()) return cannedExtractor;
  if (gatewayCredentialPresent()) return createAiExtractor();
  return notConfiguredExtractor;
}
