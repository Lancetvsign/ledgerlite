/**
 * LedgerService domain errors — stable, machine-readable codes. Tests assert on
 * the CODE, never on message text.
 */
export type LedgerErrorCode =
  | 'COMPANY_NOT_FOUND'
  | 'INACTIVE_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'PERIOD_CLOSED'
  | 'UNBALANCED_JOURNAL_ENTRY'
  | 'INSUFFICIENT_LINES'
  | 'INVALID_LINE'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  // ---- LL-033: immutability & reversal ----
  /** A posted entry cannot be edited or deleted. Corrections are made by reversal. */
  | 'POSTED_ENTRY_IMMUTABLE'
  /** The entry to reverse does not exist in this company (same shape as a real
   *  miss — a cross-company id must not reveal that it exists elsewhere). */
  | 'ENTRY_NOT_FOUND'
  /** Only a POSTED entry can be reversed; a DRAFT is edited or discarded. */
  | 'ENTRY_NOT_POSTED'
  /** The entry has already been reversed — a second reversal would double-count. */
  | 'ENTRY_ALREADY_REVERSED';

export class LedgerError extends Error {
  public override readonly name = 'LedgerError';
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
  }
}
