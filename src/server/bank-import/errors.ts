/**
 * Bank-import domain errors — LL-076. Stable, machine-readable codes; tests and the UI
 * notice map assert on the CODE, never message text.
 */
export type BankImportErrorCode =
  /** No transaction extractor is configured (the AI integration lands in LL-076b). */
  | 'EXTRACTION_NOT_CONFIGURED'
  /** The extractor returned nothing usable, or a malformed row (batch rejected, never partially staged). */
  | 'EXTRACTION_FAILED'
  /** The uploaded PDF has no text layer (a scan/image) — unsupported in v1. */
  | 'SCANNED_PDF'
  /** The chosen bank account is missing, inactive, not an asset, or not a cash account. */
  | 'INVALID_BANK_ACCOUNT'
  | 'BATCH_NOT_FOUND'
  | 'LINE_NOT_FOUND'
  /** A 'post' decision has no account. */
  | 'ACCOUNT_REQUIRED'
  /** The chosen account is A/R, A/P, Opening Balance Equity, or the bank account itself. */
  | 'CONTROL_ACCOUNT_NOT_ALLOWED'
  /** The chosen account does not exist in this company or is inactive. */
  | 'ACCOUNT_INVALID';

export class BankImportError extends Error {
  public override readonly name = 'BankImportError';
  constructor(
    public readonly code: BankImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}
