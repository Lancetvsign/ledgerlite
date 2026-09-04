import { z } from 'zod';

/**
 * Invoice input — LL-041. Money and quantities are STRINGS; a JavaScript number
 * is rejected, not coerced (ADR-004) — silent float coercion is how error enters
 * an accounting system. Totals are NOT input: the service derives subtotal / tax /
 * total from the lines with decimal.js and stores them (ADR-013), so no caller can
 * state a total that disagrees with the lines.
 */

/** A NUMERIC(19,4) decimal string: optional sign, digits, up to 4 decimals. */
const decimalString = (message: string) =>
  z.string({ message }).regex(/^-?\d{1,15}(\.\d{1,4})?$/, message);

/** A tax rate as a percentage, e.g. "8.25" for 8.25% (0–100, up to 4 decimals). */
const taxRateString = z
  .string({ message: 'Tax rate must be a string percentage, never a number (ADR-004).' })
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tax rate must be a percentage like 8.25.')
  .refine((v) => Number(v) <= 100, 'Tax rate cannot exceed 100%.');

const calendarDate = z.iso.date();

const invoiceLineInput = z.object({
  description: z.string().trim().max(500).optional().transform((v) => (v === '' ? undefined : v)),
  /** Quantity — a positive decimal (e.g. "2.5" hours). */
  quantity: decimalString('Quantity must be a decimal string, never a number (ADR-004).')
    .default('1')
    .refine((v) => !v.startsWith('-'), 'Quantity cannot be negative.'),
  /** Unit price — money. */
  unitPrice: decimalString('Unit price must be a money string, never a number (ADR-004).')
    .refine((v) => !v.startsWith('-'), 'Unit price cannot be negative.'),
  /** The revenue account this line credits. */
  accountId: z.uuid(),
  taxRate: taxRateString.default('0'),
});

export const createInvoiceInput = z.object({
  customerId: z.uuid(),
  invoiceDate: calendarDate,
  dueDate: calendarDate.optional(),
  memo: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
  lines: z.array(invoiceLineInput).min(1, 'An invoice needs at least one line.'),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceInput>;

/** Editing a DRAFT invoice replaces the header and all lines wholesale. */
export const updateInvoiceInput = createInvoiceInput;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceInput>;

/**
 * Voiding a posted (OPEN) invoice. The reversal's LINES are derived from the
 * original posted entry by the ledger, never supplied here. `reversalDate` is
 * optional (defaults to the company's today, ADR-007) and must land in an OPEN
 * period; `reason` is an optional human note recorded on the audit event.
 */
export const voidInvoiceInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidInvoiceInput = z.infer<typeof voidInvoiceInput>;

export type InvoiceLineInput = z.infer<typeof invoiceLineInput>;
