import { z } from 'zod';

import { journalSourceType } from '@/db/schema';

/**
 * Journal posting input — LL-031. Validated at the boundary; LedgerService
 * accepts only the parsed type.
 *
 * MONEY IS A STRING, and a JavaScript number is REJECTED, not coerced (ADR-004).
 * Silent coercion is exactly how float error enters an accounting system, so
 * `z.string()` refuses a number outright rather than `z.coerce`.
 */

/** A NUMERIC(19,4) money string: optional sign, digits, up to 4 decimals. */
const moneyString = z
  .string({ message: 'Money must be a string, never a number (ADR-004).' })
  .regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'Money must be a decimal string with up to 4 places.');

/** A calendar date string, YYYY-MM-DD (ADR-005). */
const calendarDate = z.iso.date();

const journalLineInput = z.object({
  accountId: z.uuid(),
  description: z.string().max(500).optional(),
  debit: moneyString.default('0'),
  credit: moneyString.default('0'),
  customerId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
});

export const postJournalEntryInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid(),
  transactionDate: calendarDate,
  /** Determines the accounting period (ADR-002). Defaults to transactionDate. */
  postingDate: calendarDate.optional(),
  description: z.string().max(1000).optional(),
  sourceType: z.enum(journalSourceType.enumValues),
  sourceId: z.string().max(200).optional(),
  idempotencyKey: z.string().max(200).optional(),
  lines: z.array(journalLineInput).min(2, 'A journal entry needs at least two lines.'),
}).refine(
  // A source-backed posting (an invoice, payment, …) comes from a machine call
  // that can time out and retry, so it MUST carry an idempotency key. A manual
  // JOURNAL_ENTRY (a human posts once) has no source and needs none. LL-032.
  (v) => v.sourceId === undefined || v.idempotencyKey !== undefined,
  { message: 'A source-backed posting requires an idempotency key.', path: ['idempotencyKey'] },
);

export type JournalLineInput = z.infer<typeof journalLineInput>;
export type PostJournalEntryInput = z.infer<typeof postJournalEntryInput>;
