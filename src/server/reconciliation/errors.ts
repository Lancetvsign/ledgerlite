/**
 * Bank-reconciliation domain errors — LL-078. Stable, machine-readable codes; tests and the
 * UI notice map assert on the CODE, never message text.
 */
export type ReconciliationErrorCode =
  /** The account is missing, inactive, not an asset, or not a cash account. */
  | 'NOT_A_BANK_ACCOUNT'
  /** This account already has an IN_PROGRESS reconciliation (one at a time). */
  | 'ALREADY_IN_PROGRESS'
  /** A reconciliation for this account and statement date already exists. */
  | 'DUPLICATE_STATEMENT_DATE'
  /** Statement dates per account must move forward: this one is not after the last COMPLETED. */
  | 'STATEMENT_DATE_NOT_AFTER_LAST'
  /** Unknown, or another company's (same answer — no existence leak). */
  | 'NOT_FOUND'
  /** The reconciliation is COMPLETED; it is final. */
  | 'NOT_IN_PROGRESS'
  /** A ticked line is not this account's, not in the ledger, dated after the statement, or already cleared. */
  | 'LINE_INVALID'
  /** Cleared lines do not sum to the statement figure. The message carries the difference. */
  | 'DIFFERENCE_NOT_ZERO';

export class ReconciliationError extends Error {
  public override readonly name = 'ReconciliationError';
  constructor(
    public readonly code: ReconciliationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
