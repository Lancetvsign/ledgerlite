/**
 * Write-off service domain errors — stable, machine-readable codes. Tests assert on
 * the CODE, never on message text.
 */
export type WriteoffErrorCode =
  | 'WRITEOFF_NOT_FOUND'
  /** Only a POSTED write-off may be voided. */
  | 'WRITEOFF_NOT_POSTED'
  /** The invoice being written off does not exist in this company. */
  | 'INVOICE_NOT_FOUND'
  /** The invoice is not OPEN (only OPEN invoices can be written off). */
  | 'INVOICE_NOT_OPEN'
  /** The amount exceeds the invoice's open balance. */
  | 'WRITEOFF_EXCEEDS_BALANCE'
  /** The expense account is missing, inactive, or not an expense account. */
  | 'WRITEOFF_ACCOUNT_INVALID'
  /** No Accounts Receivable system account is configured for this company. */
  | 'AR_ACCOUNT_NOT_CONFIGURED';

export class WriteoffError extends Error {
  public override readonly name = 'WriteoffError';
  constructor(
    public readonly code: WriteoffErrorCode,
    message: string,
  ) {
    super(message);
  }
}
