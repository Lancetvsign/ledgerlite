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
  /** LL-097: a card statement the other companies of the organization may take lines from. */
  shareWithOrganization: z.boolean().optional(),
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
  action: z.enum(['post', 'ignore', 'apply_invoice', 'apply_bill', 'match_transfer', 'personal', 'intercompany_transfer', 'match_intercompany']),
  /**
   * Required when action is 'post' or 'personal' (enforced by the service). For 'personal'
   * (LL-097) it is the owner-equity (or asset) account the charge is NOT this company's
   * expense against — typically Owner Distributions.
   */
  accountId: z.uuid().optional(),
  /** The open invoice / bill id; required for apply_* (enforced by the service). */
  documentId: z.uuid().optional(),
  /**
   * match_transfer (LL-094): the already-POSTED import line on the OTHER statement account
   * that is the mirror of this one; this line is marked posted against that entry and no
   * second entry is created. Required for match_transfer (enforced by the service).
   */
  counterpartLineId: z.uuid().optional(),
  /** intercompany_transfer (LL-099): the other company of the organization this money moved to/from. */
  counterpartCompanyId: z.uuid().optional(),
  /**
   * intercompany_transfer (LL-106): instead of a company, the OTHER company's still-staged
   * bank-statement line that is the other side of this movement; the service resolves and
   * re-proves the company from it.
   */
  counterpartStatementLineId: z.uuid().optional(),
  /** match_intercompany (LL-099): the other company's already-posted INTERCOMPANY entry for this movement. */
  counterpartEntryId: z.uuid().optional(),
});

export const postImportLinesInput = z.object({
  decisions: z.array(decisionSchema).min(1, 'Nothing to post.'),
});
export type PostImportLinesInput = z.infer<typeof postImportLinesInput>;
export type ImportLineDecision = z.infer<typeof decisionSchema>;

/**
 * LL-105: a reviewer's saved-but-not-posted choices (one per staged line) — the review screen's
 * autosave. Same shape as a decision minus the transfer counterpart line/entry ids (those are
 * recomputed on render); an empty save is a no-op. Nothing here posts.
 */
export const saveReviewDraftsInput = z.object({
  drafts: z.array(
    z.object({
      lineId: z.uuid(),
      action: z.enum(['post', 'ignore', 'apply_invoice', 'apply_bill', 'match_transfer', 'personal', 'intercompany_transfer', 'match_intercompany']),
      accountId: z.uuid().optional(),
      documentId: z.uuid().optional(),
      counterpartCompanyId: z.uuid().optional(),
    }),
  ),
});
export type SaveReviewDraftsInput = z.infer<typeof saveReviewDraftsInput>;

/** LL-105: the shared "take" screen's saved choices — tick + the viewing company's account. */
export const saveSharedDraftsInput = z.object({
  drafts: z.array(z.object({ lineId: z.uuid(), take: z.boolean(), accountId: z.uuid().optional() })),
});
export type SaveSharedDraftsInput = z.infer<typeof saveSharedDraftsInput>;

/**
 * LL-107: correct the amount of a STAGED line the extractor misread — the same signed money
 * string the extractor's rows use (negative = money out), never a number, never zero.
 */
export const amendImportLineInput = z.object({
  amount: signedMoneyString.refine((v) => /[1-9]/.test(v), 'Amount must be non-zero.'),
});
export type AmendImportLineInput = z.infer<typeof amendImportLineInput>;

/** LL-097: from a member company, take STAGED lines of a shared card statement as its own expenses. */
export const assignSharedLinesInput = z.object({
  decisions: z.array(z.object({ lineId: z.uuid(), accountId: z.uuid() })).min(1, 'Nothing to assign.'),
});
export type AssignSharedLinesInput = z.infer<typeof assignSharedLinesInput>;
