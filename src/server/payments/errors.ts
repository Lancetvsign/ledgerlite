/**
 * Payment service domain errors — stable, machine-readable codes. Tests assert on
 * the CODE, never on message text.
 */
export type PaymentErrorCode =
  | 'PAYMENT_NOT_FOUND'
  /** Only a POSTED payment may be voided. */
  | 'PAYMENT_NOT_POSTED'
  /** The paying customer does not exist in this company. */
  | 'CUSTOMER_NOT_FOUND'
  /** An applied invoice does not exist in this company. */
  | 'INVOICE_NOT_FOUND'
  /** An applied invoice is not OPEN (only OPEN invoices receive payments). */
  | 'INVOICE_NOT_OPEN'
  /** An applied invoice belongs to a different customer than the payment. */
  | 'INVOICE_WRONG_CUSTOMER'
  /** An application exceeds the invoice's open balance. */
  | 'OVERAPPLIED'
  /** The same invoice appears more than once in one payment's applications. */
  | 'DUPLICATE_INVOICE_APPLICATION'
  /** The deposit account is missing, inactive, or not an asset account. */
  | 'DEPOSIT_ACCOUNT_INVALID'
  /** No Accounts Receivable system account is configured for this company. */
  | 'AR_ACCOUNT_NOT_CONFIGURED';

export class PaymentError extends Error {
  public override readonly name = 'PaymentError';
  constructor(
    public readonly code: PaymentErrorCode,
    message: string,
  ) {
    super(message);
  }
}
