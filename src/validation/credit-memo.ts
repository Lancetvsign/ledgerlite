import { z } from 'zod';

/**
 * Customer credit-memo input — LL-051. Money is a STRING; a JavaScript number is
 * rejected, not coerced (ADR-004). A credit memo targets ONE invoice and names the
 * revenue/returns account to debit; the customer and the A/R account are derived by
 * the service (from the invoice and the company's system chart), never supplied.
 */

/** A NUMERIC(19,4) non-negative money string: digits, up to 4 decimals, no sign. */
const moneyString = (message: string) =>
  z.string({ message }).regex(/^\d{1,15}(\.\d{1,4})?$/, message);

const calendarDate = z.iso.date();

export const issueCreditMemoInput = z.object({
  invoiceId: z.uuid(),
  /** The revenue/contra account to debit (typically "Sales Returns & Allowances"); REVENUE + ACTIVE. */
  revenueAccountId: z.uuid(),
  creditDate: calendarDate,
  /** How much of the invoice to credit — strictly positive, ≤ its open balance (checked in the service). */
  amount: moneyString('Amount must be a money string, never a number (ADR-004).')
    // Positive without touching JS numbers: > 0 iff it contains a non-zero digit.
    .refine((v) => /[1-9]/.test(v), 'Amount must be positive.'),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type IssueCreditMemoInput = z.infer<typeof issueCreditMemoInput>;

/**
 * Voiding a credit memo. The reversal's LINES are derived from the credit memo's
 * posted entry by the ledger, never supplied here. `reversalDate` is optional
 * (defaults to the company's today, ADR-007) and must land in an OPEN period.
 */
export const voidCreditMemoInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidCreditMemoInput = z.infer<typeof voidCreditMemoInput>;
