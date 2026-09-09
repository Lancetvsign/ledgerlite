import { z } from 'zod';

/**
 * Year-end closing input — LL-073. Closing a fiscal year posts the entry that zeroes
 * that year's revenue/COGS/expense accounts into Retained Earnings. `fiscalYearStart`
 * is a date identifying the fiscal year to close; the service normalises it to the
 * company's canonical fiscal-year start (from `fiscalYearStartMonth`) and uses that as
 * the source key, so at most one close exists per (company, fiscal year).
 */

const calendarDate = z.iso.date();

export const closeFiscalYearInput = z.object({
  /** Any date within the fiscal year to close; normalised to the canonical start. */
  fiscalYearStart: calendarDate,
  /** Optional client-generated request id for submit-once idempotency (LL-067). */
  idempotencyKey: z.uuid().optional(),
});
export type CloseFiscalYearInput = z.infer<typeof closeFiscalYearInput>;

/**
 * Reopening a closed fiscal year — reverses its closing entry (the derived lines come
 * from the ledger, never supplied here). The reversal is always dated the fiscal-year
 * end (the closing entry's own period), so closing and reversal cancel cleanly; there is
 * no reversal-date override. That period must be OPEN.
 */
export const reopenFiscalYearInput = z.object({
  fiscalYearStart: calendarDate,
  reason: z.string().trim().max(1000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type ReopenFiscalYearInput = z.infer<typeof reopenFiscalYearInput>;
