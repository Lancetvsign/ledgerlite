import { z } from 'zod';

/**
 * Opening-balances input — LL-071. The one-time conversion entry a company posts when
 * it adopts LedgerLite mid-life, seeding each non-control balance-sheet account's
 * starting balance as of a conversion date. The service appends the balancing Opening
 * Balance Equity line, so the caller supplies only the real account balances.
 *
 * Money is a STRING; a JavaScript number is rejected, not coerced (ADR-004). Unlike the
 * manual journal line, an opening-balance amount may NOT be negative — a balance is
 * entered on its natural side (a debit OR a credit), never as a negative on the other.
 */

/** A NUMERIC(19,4) non-negative money string: digits, up to 4 decimals, no sign. */
const moneyString = (message: string) =>
  z.string({ message }).regex(/^\d{1,15}(\.\d{1,4})?$/, message);

const calendarDate = z.iso.date();

/** True iff a non-negative money string is strictly positive (has a non-zero digit). */
const isPositive = (v: string) => /[1-9]/.test(v);

/**
 * One opening-balance line: an account and its starting balance on exactly one side.
 * Exactly-one-positive-side mirrors the ledger's line structure rule; the service
 * additionally rejects A/R, A/P, and the Opening Balance Equity account.
 */
const openingBalanceLine = z
  .object({
    accountId: z.uuid(),
    debit: moneyString('Debit must be a money string, never a number (ADR-004).').default('0'),
    credit: moneyString('Credit must be a money string, never a number (ADR-004).').default('0'),
  })
  .refine((l) => isPositive(l.debit) !== isPositive(l.credit), {
    message: 'Each line must have a positive amount on exactly one side (a debit or a credit).',
  });

export const setOpeningBalancesInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid(),
  /** The conversion date — the entry posts on this date; its period must be OPEN. */
  conversionDate: calendarDate,
  /** Optional client-generated request id for submit-once idempotency (LL-067). Never money. */
  idempotencyKey: z.uuid().optional(),
  /** At least one real account line; the service appends the Opening Balance Equity plug. */
  lines: z.array(openingBalanceLine).min(1, 'Enter at least one opening balance.'),
});
export type SetOpeningBalancesInput = z.infer<typeof setOpeningBalancesInput>;
export type OpeningBalanceLineInput = z.infer<typeof openingBalanceLine>;

/**
 * Voiding the opening-balance entry (to correct a mistake during setup). The reversal's
 * lines are derived from the posted entry by the ledger, never supplied here.
 * `reversalDate` is optional (defaults to the company's today, ADR-007) and must land in
 * an OPEN period.
 */
export const voidOpeningBalancesInput = z.object({
  reversalDate: calendarDate.optional(),
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type VoidOpeningBalancesInput = z.infer<typeof voidOpeningBalancesInput>;
