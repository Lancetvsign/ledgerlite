/**
 * Bill service domain errors — stable, machine-readable codes. Tests assert on the
 * CODE, never on message text. The A/P mirror of the invoice errors.
 */
export type BillErrorCode =
  | 'BILL_NOT_FOUND'
  /** Only a DRAFT bill may be edited or finalized; OPEN/PAID/VOID are not. */
  | 'BILL_NOT_DRAFT'
  /** Only an OPEN bill may be voided (DRAFT is discarded, not voided; PAID/VOID cannot). */
  | 'BILL_NOT_OPEN'
  /**
   * The bill has live (non-void) bill payments applied; void those first (LL-062).
   * Voiding the bill reverses its FULL A/P, but a payment's Dr A/P would remain,
   * driving the vendor's A/P negative and breaking the aging⇔control tie — the A/P
   * twin of INVOICE_HAS_PAYMENTS. (LL-063 extends this to vendor credits.)
   */
  | 'BILL_HAS_PAYMENTS'
  /** Finalizing a zero-total bill would produce no postable entry. */
  | 'BILL_ZERO_TOTAL'
  /** The vendor does not exist in this company. */
  | 'VENDOR_NOT_FOUND'
  /** A line references an account that does not exist in this company. */
  | 'ACCOUNT_NOT_FOUND'
  /**
   * A line references a system CONTROL account (non-null system_account_type, e.g.
   * Accounts Payable or Accounts Receivable). Debiting A/P as an "expense" line posts
   * Dr A/P / Cr A/P — balanced, but it breaks the aging⇔control reconciliation.
   * Bill lines post to ordinary expense accounts only.
   */
  | 'LINE_ACCOUNT_INVALID'
  /** No Accounts Payable system account is configured for this company. */
  | 'AP_ACCOUNT_NOT_CONFIGURED';

export class BillError extends Error {
  public override readonly name = 'BillError';
  constructor(
    public readonly code: BillErrorCode,
    message: string,
  ) {
    super(message);
  }
}
