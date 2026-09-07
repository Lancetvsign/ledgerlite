import { z } from 'zod';

/**
 * Bill input — LL-061 (Accounts Payable), the mirror of the invoice input. Money
 * and quantities are STRINGS; a JavaScript number is rejected, not coerced (ADR-004).
 * The total is NOT input: the service derives it from the lines with decimal.js and
 * stores it (ADR-013). No tax leg (LL-061 scope) — a bill's total is the sum of its
 * expense lines.
 */

/** A NUMERIC(19,4) decimal string: optional sign, digits, up to 4 decimals. */
const decimalString = (message: string) =>
  z.string({ message }).regex(/^-?\d{1,15}(\.\d{1,4})?$/, message);

const calendarDate = z.iso.date();

const billLineInput = z.object({
  description: z.string().trim().max(500).optional().transform((v) => (v === '' ? undefined : v)),
  /** Quantity — a positive decimal (e.g. "2.5"). */
  quantity: decimalString('Quantity must be a decimal string, never a number (ADR-004).')
    .default('1')
    .refine((v) => !v.startsWith('-'), 'Quantity cannot be negative.'),
  /** Unit price — money. */
  unitPrice: decimalString('Unit price must be a money string, never a number (ADR-004).')
    .refine((v) => !v.startsWith('-'), 'Unit price cannot be negative.'),
  /** The expense account this line debits. */
  accountId: z.uuid(),
});

export const createBillInput = z.object({
  vendorId: z.uuid(),
  billDate: calendarDate,
  dueDate: calendarDate.optional(),
  memo: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
  lines: z.array(billLineInput).min(1, 'A bill needs at least one line.'),
});
export type CreateBillInput = z.infer<typeof createBillInput>;

/** Editing a DRAFT bill replaces the header and all lines wholesale. */
export const updateBillInput = createBillInput;
export type UpdateBillInput = z.infer<typeof updateBillInput>;

/**
 * Voiding a posted (OPEN) bill. The reversal's LINES are derived from the original
 * posted entry by the ledger, never supplied here. `reversalDate` is optional
 * (defaults to the company's today, ADR-007) and must land in an OPEN period;
 * `reason` is an optional human note recorded on the audit event.
 */
export const voidBillInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidBillInput = z.infer<typeof voidBillInput>;

export type BillLineInput = z.infer<typeof billLineInput>;
