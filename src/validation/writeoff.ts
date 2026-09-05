import { z } from 'zod';

/**
 * Bad-debt write-off input — LL-050. Money is a STRING; a JavaScript number is
 * rejected, not coerced (ADR-004). A write-off targets ONE invoice and names the
 * expense account to debit; the customer and the A/R account are derived by the
 * service (from the invoice and the company's system chart), never supplied.
 */

/** A NUMERIC(19,4) non-negative money string: digits, up to 4 decimals, no sign. */
const moneyString = (message: string) =>
  z.string({ message }).regex(/^\d{1,15}(\.\d{1,4})?$/, message);

const calendarDate = z.iso.date();

export const writeOffInvoiceInput = z.object({
  invoiceId: z.uuid(),
  /** The expense account to debit (typically "Bad Debt Expense"); must be EXPENSE + ACTIVE. */
  expenseAccountId: z.uuid(),
  writeoffDate: calendarDate,
  /** How much of the invoice to write off — strictly positive, ≤ its open balance (checked in the service). */
  amount: moneyString('Amount must be a money string, never a number (ADR-004).')
    // Positive without touching JS numbers: > 0 iff it contains a non-zero digit.
    .refine((v) => /[1-9]/.test(v), 'Amount must be positive.'),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type WriteOffInvoiceInput = z.infer<typeof writeOffInvoiceInput>;

/**
 * Voiding a write-off. The reversal's LINES are derived from the write-off's posted
 * entry by the ledger, never supplied here. `reversalDate` is optional (defaults to
 * the company's today, ADR-007) and must land in an OPEN period.
 */
export const voidWriteoffInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidWriteoffInput = z.infer<typeof voidWriteoffInput>;
