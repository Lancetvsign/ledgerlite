/**
 * Invoice service domain errors — stable, machine-readable codes. Tests assert on
 * the CODE, never on message text.
 */
export type InvoiceErrorCode =
  | 'INVOICE_NOT_FOUND'
  /** Only a DRAFT invoice may be edited; OPEN/PAID/VOID are immutable. */
  | 'INVOICE_NOT_DRAFT'
  /** The billed customer does not exist in this company. */
  | 'CUSTOMER_NOT_FOUND'
  /** A line references an account that does not exist in this company. */
  | 'ACCOUNT_NOT_FOUND';

export class InvoiceError extends Error {
  public override readonly name = 'InvoiceError';
  constructor(
    public readonly code: InvoiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
