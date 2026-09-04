import { z } from 'zod';

/**
 * Payment input — LL-043. Money is a STRING; a JavaScript number is rejected, not
 * coerced (ADR-004). The payment's `amount` is NOT input: it is the sum of the
 * applications, derived by the service (a fully-applied payment, ADR-015), so no
 * caller can state an amount that disagrees with what it applies.
 */

/** A NUMERIC(19,4) non-negative money string: digits, up to 4 decimals, no sign. */
const moneyString = (message: string) =>
  z.string({ message }).regex(/^\d{1,15}(\.\d{1,4})?$/, message);

const calendarDate = z.iso.date();

const paymentApplicationInput = z.object({
  invoiceId: z.uuid(),
  /** How much of this payment applies to this invoice — strictly positive money. */
  amountApplied: moneyString('Amount applied must be a money string, never a number (ADR-004).')
    // Positive without touching JS numbers: a non-negative money string is > 0 iff
    // it contains a non-zero digit ('0.0000' does not; '0.0001' does).
    .refine((v) => /[1-9]/.test(v), 'Amount applied must be positive.'),
});

export const receivePaymentInput = z.object({
  customerId: z.uuid(),
  paymentDate: calendarDate,
  /** The asset account the money lands in (Cash / Checking / Undeposited Funds). */
  depositAccountId: z.uuid(),
  method: z.string().trim().max(50).optional().transform((v) => (v === '' ? undefined : v)),
  reference: z.string().trim().max(100).optional().transform((v) => (v === '' ? undefined : v)),
  memo: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
  applications: z
    .array(paymentApplicationInput)
    .min(1, 'A payment must apply to at least one invoice.'),
});
export type ReceivePaymentInput = z.infer<typeof receivePaymentInput>;

/**
 * Voiding a payment. The reversal's LINES are derived from the payment's posted
 * entry by the ledger, never supplied here. `reversalDate` is optional (defaults to
 * the company's today, ADR-007) and must land in an OPEN period.
 */
export const voidPaymentInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidPaymentInput = z.infer<typeof voidPaymentInput>;

export type PaymentApplicationInput = z.infer<typeof paymentApplicationInput>;
