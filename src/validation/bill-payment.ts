import { z } from 'zod';

/**
 * Bill-payment input — LL-062, the mirror of the payment input. Money is a STRING; a
 * JavaScript number is rejected, not coerced (ADR-004). The payment's `amount` is NOT
 * input: it is the sum of the applications, derived by the service, so no caller can
 * state an amount that disagrees with what it applies.
 */

/** A NUMERIC(19,4) non-negative money string: digits, up to 4 decimals, no sign. */
const moneyString = (message: string) =>
  z.string({ message }).regex(/^\d{1,15}(\.\d{1,4})?$/, message);

const calendarDate = z.iso.date();

const billPaymentApplicationInput = z.object({
  billId: z.uuid(),
  /** How much of this payment applies to this bill — strictly positive money. */
  amountApplied: moneyString('Amount applied must be a money string, never a number (ADR-004).')
    .refine((v) => /[1-9]/.test(v), 'Amount applied must be positive.'),
});

export const payBillInput = z.object({
  vendorId: z.uuid(),
  paymentDate: calendarDate,
  /** The asset account the money leaves (Cash / Checking). */
  cashAccountId: z.uuid(),
  method: z.string().trim().max(50).optional().transform((v) => (v === '' ? undefined : v)),
  reference: z.string().trim().max(100).optional().transform((v) => (v === '' ? undefined : v)),
  memo: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
  applications: z
    .array(billPaymentApplicationInput)
    .min(1, 'A bill payment must apply to at least one bill.'),
});
export type PayBillInput = z.infer<typeof payBillInput>;

/**
 * Voiding a bill payment. The reversal's LINES are derived from the payment's posted
 * entry by the ledger, never supplied here. `reversalDate` is optional (defaults to
 * the company's today, ADR-007) and must land in an OPEN period.
 */
export const voidBillPaymentInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidBillPaymentInput = z.infer<typeof voidBillPaymentInput>;

export type BillPaymentApplicationInput = z.infer<typeof billPaymentApplicationInput>;
