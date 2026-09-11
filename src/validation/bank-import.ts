import { z } from 'zod';

/**
 * Bank-statement import input — LL-076. Money is a STRING; a JavaScript number is rejected,
 * not coerced (ADR-004). A statement amount is SIGNED: positive = money into the bank,
 * negative = money out. Extracted rows come from an untrusted source (a model or a file),
 * so every field is validated before it is staged — a malformed row rejects the batch
 * rather than being silently dropped (a lost transaction is worse than a retry).
 */

/** A signed NUMERIC(19,4) money string. */
const signedMoneyString = z
  .string({ message: 'Amount must be a money string, never a number (ADR-004).' })
  .regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'Amount must be a money string, never a number (ADR-004).');

const calendarDate = z.iso.date();

/** One transaction as extracted from a statement. */
export const extractedTransactionSchema = z.object({
  date: calendarDate,
  description: z.string().trim().min(1, 'Description is required.').max(500),
  amount: signedMoneyString.refine((v) => /[1-9]/.test(v), 'Amount must be non-zero.'),
  /** The extractor's proposed category (free text), mapped to a chart account when possible. */
  category: z.string().trim().max(120).optional(),
});
export type ExtractedTransaction = z.infer<typeof extractedTransactionSchema>;
export const extractedTransactionsSchema = z.array(extractedTransactionSchema);

export const stageImportInput = z.object({
  /** The cash/bank account the statement is for (must be ACTIVE, ASSET, cashFlowCategory CASH). */
  bankAccountId: z.uuid(),
  filename: z.string().trim().max(255).optional(),
  /** The uploaded statement's bytes, in memory — what the extractor reads. Never persisted. */
  fileBytes: z.instanceof(Uint8Array),
});
export type StageImportInput = z.infer<typeof stageImportInput>;

const decisionSchema = z.object({
  lineId: z.uuid(),
  /**
   * post = categorise to `accountId`; ignore = drop; apply_invoice / apply_bill (LL-077) =
   * settle the open document `documentId` with the line's full amount through a real
   * customer payment / bill payment. Direction is enforced by the service: money in may
   * only apply to an invoice, money out only to a bill.
   */
  action: z.enum(['post', 'ignore', 'apply_invoice', 'apply_bill']),
  /** Required when action is 'post' (enforced by the service). */
  accountId: z.uuid().optional(),
  /** The open invoice / bill id; required for apply_* (enforced by the service). */
  documentId: z.uuid().optional(),
});

export const postImportLinesInput = z.object({
  decisions: z.array(decisionSchema).min(1, 'Nothing to post.'),
});
export type PostImportLinesInput = z.infer<typeof postImportLinesInput>;
export type ImportLineDecision = z.infer<typeof decisionSchema>;
