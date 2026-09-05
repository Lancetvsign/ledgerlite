/**
 * Credit-memo service domain errors — stable, machine-readable codes. Tests assert
 * on the CODE, never on message text.
 */
export type CreditMemoErrorCode =
  | 'CREDIT_MEMO_NOT_FOUND'
  /** Only a POSTED credit memo may be voided. */
  | 'CREDIT_MEMO_NOT_POSTED'
  /** The invoice being credited does not exist in this company. */
  | 'INVOICE_NOT_FOUND'
  /** The invoice is not OPEN (only OPEN invoices can be credited). */
  | 'INVOICE_NOT_OPEN'
  /** The amount exceeds the invoice's open balance. */
  | 'CREDIT_EXCEEDS_BALANCE'
  /** The revenue/returns account is missing, inactive, or not a revenue account. */
  | 'CREDIT_ACCOUNT_INVALID'
  /** No Accounts Receivable system account is configured for this company. */
  | 'AR_ACCOUNT_NOT_CONFIGURED';

export class CreditMemoError extends Error {
  public override readonly name = 'CreditMemoError';
  constructor(
    public readonly code: CreditMemoErrorCode,
    message: string,
  ) {
    super(message);
  }
}
