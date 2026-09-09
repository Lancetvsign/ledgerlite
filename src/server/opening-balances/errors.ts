/**
 * Opening-balances domain errors — LL-071. Stable, machine-readable codes; tests and
 * the UI notice map assert on the CODE, never on message text.
 */
export type OpeningBalanceErrorCode =
  /** A line targets the A/R or A/P control account — not allowed. Opening receivables
   *  and payables are entered as open invoices/bills so the subsidiary reconciles. */
  | 'CONTROL_ACCOUNT_NOT_ALLOWED'
  /** A line targets Opening Balance Equity itself — the service computes that plug. */
  | 'OBE_NOT_ALLOWED'
  /** The company has no Opening Balance Equity system account configured. */
  | 'OBE_ACCOUNT_NOT_CONFIGURED'
  /** A POSTED opening-balance entry already exists — void it before setting again. */
  | 'OPENING_BALANCE_ALREADY_SET'
  /** No POSTED opening-balance entry exists to void. */
  | 'OPENING_BALANCE_NOT_SET';

export class OpeningBalanceError extends Error {
  public override readonly name = 'OpeningBalanceError';
  constructor(
    public readonly code: OpeningBalanceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
