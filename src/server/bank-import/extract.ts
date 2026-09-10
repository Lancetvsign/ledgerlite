import 'server-only';

import { BankImportError } from './errors';

import type { ExtractedTransaction } from '@/validation/bank-import';

/**
 * The transaction-extraction seam — LL-076.
 *
 * `stageImport` takes an extractor so the pipeline (staging, review, posting) is exercised
 * deterministically in tests without any external model. LL-076a ships this seam with:
 *   - `notConfiguredExtractor` — the production default until the AI integration lands
 *     (LL-076b), so the upload surface honestly reports "not configured" rather than guess;
 *   - `cannedExtractor` — a fixed synthetic statement, selected ONLY when the
 *     `BANK_IMPORT_TEST_EXTRACTOR=1` env flag is set (e2e / dev). Never enabled in
 *     production; it exists so the upload → review → post loop can be driven end to end.
 * LL-076b replaces the production default with the AI SDK extractor behind the same
 * signature; the canned one stays as the e2e stub (a real model is non-deterministic and
 * needs a key, so it is never exercised in CI).
 */
export type TransactionExtractor = (fileText: string) => Promise<ExtractedTransaction[]>;

export const notConfiguredExtractor: TransactionExtractor = () => {
  throw new BankImportError(
    'EXTRACTION_NOT_CONFIGURED',
    'Statement extraction is not configured yet. The AI extraction integration is a follow-up.',
  );
};

/**
 * Synthetic, deterministic statement lines (money in is positive, out is negative). The
 * categories name standard-chart accounts so the AI→account mapping is exercised.
 */
export const cannedExtractor: TransactionExtractor = () =>
  Promise.resolve([
    { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Sales Revenue' },
    { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50', category: 'Office Supplies' },
    { date: '2026-06-05', description: 'MONTHLY RENT PAYMENT', amount: '-2000.00', category: 'Rent' },
  ]);

/** Whether an extractor is available (drives the upload page's "not configured" state). */
export function isExtractionConfigured(): boolean {
  return process.env.BANK_IMPORT_TEST_EXTRACTOR === '1';
}

/** The production extractor for this build. */
export function resolveExtractor(): TransactionExtractor {
  return isExtractionConfigured() ? cannedExtractor : notConfiguredExtractor;
}
