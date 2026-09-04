/**
 * Invoice service domain errors — stable, machine-readable codes. Tests assert on
 * the CODE, never on message text.
 */
export type InvoiceErrorCode =
  | 'INVOICE_NOT_FOUND'
  /** Only a DRAFT invoice may be edited or finalized; OPEN/PAID/VOID are not. */
  | 'INVOICE_NOT_DRAFT'
  /** Only an OPEN invoice may be voided (DRAFT is discarded, not voided; PAID/VOID cannot). */
  | 'INVOICE_NOT_OPEN'
  /** The invoice has live (non-void) payments applied; void those first (LL-043). */
  | 'INVOICE_HAS_PAYMENTS'
  /** Finalizing a zero-total invoice would produce no postable entry. */
  | 'INVOICE_ZERO_TOTAL'
  /** The billed customer does not exist in this company. */
  | 'CUSTOMER_NOT_FOUND'
  /** A line references an account that does not exist in this company. */
  | 'ACCOUNT_NOT_FOUND'
  /**
   * A line references a system CONTROL account (non-null system_account_type, e.g.
   * Accounts Receivable or Sales Tax Payable). Crediting A/R as a "revenue" line
   * posts Dr A/R / Cr A/R — balanced, but it breaks the aging⇔control
   * reconciliation (GL-T018 / ADR-016). Invoice lines post to ordinary accounts only.
   */
  | 'LINE_ACCOUNT_INVALID'
  /** No Accounts Receivable system account is configured for this company. */
  | 'AR_ACCOUNT_NOT_CONFIGURED'
  /** The invoice has tax but no Sales Tax Payable system account is configured. */
  | 'TAX_ACCOUNT_NOT_CONFIGURED';

export class InvoiceError extends Error {
  public override readonly name = 'InvoiceError';
  constructor(
    public readonly code: InvoiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
