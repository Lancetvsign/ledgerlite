/** Typed accounting-period errors with stable codes. */
export type PeriodErrorCode =
  | 'PERIOD_CLOSED'
  | 'PERIOD_NOT_FOUND'
  | 'PERIOD_ALREADY_CLOSED'
  | 'PERIOD_ALREADY_OPEN'
  | 'INVALID_DATE';

export class PeriodError extends Error {
  public override readonly name = 'PeriodError';
  constructor(
    public readonly code: PeriodErrorCode,
    message: string,
  ) {
    super(message);
  }
}
