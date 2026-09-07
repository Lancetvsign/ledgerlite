/**
 * Vendor-credit service domain errors — stable, machine-readable codes. Tests assert
 * on the CODE, never on message text. The A/P mirror of the credit-memo errors.
 */
export type VendorCreditErrorCode =
  | 'VENDOR_CREDIT_NOT_FOUND'
  /** Only a POSTED vendor credit may be voided. */
  | 'VENDOR_CREDIT_NOT_POSTED'
  /** The bill being credited does not exist in this company. */
  | 'BILL_NOT_FOUND'
  /** The bill is not OPEN (only OPEN bills can be credited). */
  | 'BILL_NOT_OPEN'
  /** The amount exceeds the bill's open balance. */
  | 'CREDIT_EXCEEDS_BALANCE'
  /** The expense/contra account is missing, inactive, or not an expense account. */
  | 'CREDIT_ACCOUNT_INVALID'
  /** No Accounts Payable system account is configured for this company. */
  | 'AP_ACCOUNT_NOT_CONFIGURED';

export class VendorCreditError extends Error {
  public override readonly name = 'VendorCreditError';
  constructor(
    public readonly code: VendorCreditErrorCode,
    message: string,
  ) {
    super(message);
  }
}
