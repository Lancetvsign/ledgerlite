import { z } from 'zod';

/**
 * Bank reconciliation input — LL-078. Money is a STRING (ADR-004). The statement's ending
 * figure is SIGNED: an overdrawn account ends negative. Cleared lines are sent as the full
 * set of journal-line ids the reviewer ticked (the service replaces the saved set).
 */

const signedMoneyString = z
  .string({ message: 'Amount must be a money string, never a number (ADR-004).' })
  .regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'Amount must be a money string, never a number (ADR-004).');

const calendarDate = z.iso.date();

export const startReconciliationInput = z.object({
  /** The cash/bank account (must be ACTIVE, ASSET, cashFlowCategory CASH). */
  bankAccountId: z.uuid(),
  statementDate: calendarDate,
  /** The bank's ending figure as printed on the statement. */
  statementEndingAmount: signedMoneyString,
});
export type StartReconciliationInput = z.infer<typeof startReconciliationInput>;

export const updateReconciliationInput = z
  .object({
    statementDate: calendarDate.optional(),
    statementEndingAmount: signedMoneyString.optional(),
  })
  .refine((v) => v.statementDate !== undefined || v.statementEndingAmount !== undefined, 'Nothing to update.');
export type UpdateReconciliationInput = z.infer<typeof updateReconciliationInput>;

export const setClearedInput = z.object({
  /** Every ledger line the reviewer has ticked as cleared — the full set, not a delta. */
  journalLineIds: z.array(z.uuid()).transform((ids) => [...new Set(ids)]),
});
export type SetClearedInput = z.infer<typeof setClearedInput>;
