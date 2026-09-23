/** Typed account-domain errors with stable, machine-readable codes. */
export type AccountErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_CYCLE'
  | 'DUPLICATE_ACCOUNT_NUMBER'
  | 'SYSTEM_ACCOUNT_PROTECTED'
  /** An intercompany pair was requested across companies that are not both ACTIVE members of one organization with one currency (LL-096). */
  | 'INTERCOMPANY_NOT_ALLOWED';

export class AccountError extends Error {
  public override readonly name = 'AccountError';
  constructor(
    public readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
  }
}
