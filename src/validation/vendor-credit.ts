import { z } from 'zod';

/**
 * Vendor-credit input — LL-063 (the A/P mirror of LL-051's credit memo). Money is a
 * STRING; a JavaScript number is rejected, not coerced (ADR-004). A vendor credit
 * targets ONE bill and names the expense account to credit; the vendor and the A/P
 * account are derived by the service (from the bill and the company's system chart),
 * never supplied.
 */

/** A NUMERIC(19,4) non-negative money string: digits, up to 4 decimals, no sign. */
const moneyString = (message: string) =>
  z.string({ message }).regex(/^\d{1,15}(\.\d{1,4})?$/, message);

const calendarDate = z.iso.date();

export const issueVendorCreditInput = z.object({
  billId: z.uuid(),
  /** The expense/contra account to credit (a return reduces an expense); EXPENSE + ACTIVE. */
  expenseAccountId: z.uuid(),
  creditDate: calendarDate,
  /** How much of the bill to credit — strictly positive, ≤ its open balance (checked in the service). */
  amount: moneyString('Amount must be a money string, never a number (ADR-004).')
    // Positive without touching JS numbers: > 0 iff it contains a non-zero digit.
    .refine((v) => /[1-9]/.test(v), 'Amount must be positive.'),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
  /** Optional client-generated request id for submit-once idempotency (LL-067): a retry
   *  with the SAME key returns the original credit instead of crediting twice. Never money. */
  idempotencyKey: z.uuid().optional(),
});
export type IssueVendorCreditInput = z.infer<typeof issueVendorCreditInput>;

/**
 * Voiding a vendor credit. The reversal's LINES are derived from the vendor credit's
 * posted entry by the ledger, never supplied here. `reversalDate` is optional
 * (defaults to the company's today, ADR-007) and must land in an OPEN period.
 */
export const voidVendorCreditInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidVendorCreditInput = z.infer<typeof voidVendorCreditInput>;
