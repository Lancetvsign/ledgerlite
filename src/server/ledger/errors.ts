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
  | 'IDEMPOTENCY_KEY_CONFLICT';

export class LedgerError extends Error {
  public override readonly name = 'LedgerError';
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
  }
}
