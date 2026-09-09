/**
 * Year-end closing domain errors — LL-073. Stable, machine-readable codes; tests and the
 * UI notice map assert on the CODE, never message text.
 */
export type YearEndErrorCode =
  /** The company has no Retained Earnings system account configured. */
  | 'RE_ACCOUNT_NOT_CONFIGURED'
  /** The fiscal year has no revenue/expense activity to close. */
  | 'NOTHING_TO_CLOSE'
  /** A closing entry already exists for this fiscal year — reopen it before re-closing. */
  | 'YEAR_ALREADY_CLOSED'
  /** No closing entry exists for this fiscal year to reopen. */
  | 'YEAR_NOT_CLOSED';

export class YearEndError extends Error {
  public override readonly name = 'YearEndError';
  constructor(
    public readonly code: YearEndErrorCode,
    message: string,
  ) {
    super(message);
  }
}
