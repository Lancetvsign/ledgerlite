/**
 * Bill-payment service domain errors — stable, machine-readable codes. Tests assert
 * on the CODE, never on message text. The A/P mirror of the payment errors.
 */
export type BillPaymentErrorCode =
  | 'BILL_PAYMENT_NOT_FOUND'
  /** Only a POSTED bill payment may be voided. */
  | 'BILL_PAYMENT_NOT_POSTED'
  /** The paid vendor does not exist in this company. */
  | 'VENDOR_NOT_FOUND'
  /** An applied bill does not exist in this company. */
  | 'BILL_NOT_FOUND'
  /** An applied bill is not OPEN (only OPEN bills receive payments). */
  | 'BILL_NOT_OPEN'
  /** An applied bill belongs to a different vendor than the payment. */
  | 'BILL_WRONG_VENDOR'
  /** An application exceeds the bill's open balance. */
  | 'OVERAPPLIED'
  /** The same bill appears more than once in one payment's applications. */
  | 'DUPLICATE_BILL_APPLICATION'
  /** The cash account is missing, inactive, not an asset, or is the A/P control. */
  | 'CASH_ACCOUNT_INVALID'
  /** No Accounts Payable system account is configured for this company. */
  | 'AP_ACCOUNT_NOT_CONFIGURED';

export class BillPaymentError extends Error {
  public override readonly name = 'BillPaymentError';
  constructor(
    public readonly code: BillPaymentErrorCode,
    message: string,
  ) {
    super(message);
  }
}
