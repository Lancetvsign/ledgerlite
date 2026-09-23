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
  /** The batch has at least one POSTED line — it is part of the ledger's history now (LL-087). */
  | 'BATCH_HAS_POSTINGS'
  | 'LINE_NOT_FOUND'
  /** A 'post' decision has no account. */
  | 'ACCOUNT_REQUIRED'
  /** The chosen account is A/R, A/P, Opening Balance Equity, or the bank account itself. */
  | 'CONTROL_ACCOUNT_NOT_ALLOWED'
  /** The chosen account does not exist in this company or is inactive. */
  | 'ACCOUNT_INVALID'
  /** An apply_* decision names no invoice / bill (LL-077). */
  | 'DOCUMENT_REQUIRED'
  /** apply_invoice on money OUT, or apply_bill on money IN. */
  | 'WRONG_DIRECTION'
  /** A credit-card statement line can only be posted to an account, not applied to a document (LL-088). */
  | 'CARD_CANNOT_APPLY'
  /** match_transfer named a counterpart that is not this line's posted mirror on another statement account (LL-094). */
  | 'TRANSFER_MISMATCH'
  /** The transfer's other side already posted this movement; posting it again would double-count (LL-094). */
  | 'TRANSFER_ALREADY_POSTED'
  /** The document is not an OPEN invoice / bill of this company (missing, closed, or foreign — one message). */
  | 'DOCUMENT_NOT_OPEN'
  /** The line's amount (cumulatively, within one submit) exceeds the document's open balance. */
  | 'OVERAPPLIED'
  /** Sharing needs the company to be in an organization (LL-097). */
  | 'NOT_IN_ORGANIZATION'
  /** Only a credit-card statement can be shared with the organization (LL-097). */
  | 'ONLY_CARDS_SHAREABLE'
  /** The named counterpart is not an organization member the actor may act in (LL-099). */
  | 'COUNTERPART_INVALID'
  /** This company already posted its side of that intercompany movement (LL-099). */
  | 'TRANSFER_ALREADY_MATCHED';

export class BankImportError extends Error {
  public override readonly name = 'BankImportError';
  constructor(
    public readonly code: BankImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}
