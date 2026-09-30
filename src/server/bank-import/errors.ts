import { LedgerError } from '@/server/ledger/errors';

/**
 * Bank-import domain errors — LL-076. Stable, machine-readable codes; tests and the UI
 * notice map assert on the CODE, never message text.
 */
export type BankImportErrorCode =
  /** No transaction extractor is configured (the AI integration lands in LL-076b). */
  | 'EXTRACTION_NOT_CONFIGURED'
  /** The extractor returned nothing usable, or a malformed row (batch rejected, never partially staged). */
  | 'EXTRACTION_FAILED'
  /**
   * LL-113: the AI service could not read the statement for a reason that is NOT the statement —
   * so the upload page says what is wrong instead of blaming the file. See `classifyModelFailure`.
   */
  /** The service rejected this app's API key (401 / 403) — an administrator must replace it and redeploy. */
  | 'EXTRACTION_KEY_REJECTED'
  /** The service account is out of credit (402, or the provider's "credit balance" / quota refusal). */
  | 'EXTRACTION_OUT_OF_CREDIT'
  /** The configured model was not found (404) — a configuration problem. */
  | 'EXTRACTION_MODEL_UNAVAILABLE'
  /** Too many requests (429) — wait and upload again. */
  | 'EXTRACTION_RATE_LIMITED'
  /** The service is down or unreachable (5xx, overloaded, network) — try again later. */
  | 'EXTRACTION_SERVICE_UNAVAILABLE'
  /** LL-127: the AI did not answer within the upload's time budget and was stopped — nothing was imported. */
  | 'EXTRACTION_TIMED_OUT'
  /** The uploaded PDF has no text layer (a scan/image) — unsupported in v1. */
  | 'SCANNED_PDF'
  /** The chosen bank account is missing, inactive, not an asset, or not a cash account. */
  | 'INVALID_BANK_ACCOUNT'
  | 'BATCH_NOT_FOUND'
  /** The batch has at least one POSTED line — it is part of the ledger's history now (LL-087). */
  | 'BATCH_HAS_POSTINGS'
  /** LL-124: some posted lines must be undone on their own screens first (a payment's void, Undo transfer, …). */
  | 'BATCH_UNDO_BLOCKED'
  | 'LINE_NOT_FOUND'
  /** LL-107: only a STAGED line can be corrected; a decided one is frozen. */
  | 'LINE_NOT_EDITABLE'
  /** LL-107: a line's amount was corrected between the reviewer's read and the post — reload. */
  | 'LINE_CHANGED'
  /** LL-110: this line is undone somewhere else (void its payment, Undo transfer, the taker's give-back, the ignore's Undo). */
  | 'UNPOST_ELSEWHERE'
  /** LL-110: the line's posting is cleared in a bank reconciliation. */
  | 'LINE_RECONCILED'
  /** LL-116: the chosen reversal date is before the original posting or after today. */
  | 'UNDO_DATE_INVALID'
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
  /** LL-106: an intercompany transfer named neither a statement line nor a company (a line still waiting for its match). */
  | 'COUNTERPART_REQUIRED'
  /** This company already posted its side of that intercompany movement (LL-099). */
  | 'TRANSFER_ALREADY_MATCHED'
  /** A card CHARGE cannot be an intercompany bank transfer — only a card payment/refund can (LL-102). */
  | 'CARD_CHARGE_NOT_TRANSFER'
  /** A card PAYMENT (mirrored by the cardholder's own bank) cannot be taken by another company (LL-102). */
  | 'CARD_PAYMENT_NOT_TAKEABLE';

export class BankImportError extends Error {
  public override readonly name = 'BankImportError';
  constructor(
    public readonly code: BankImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A two-company posting found a CLOSED period in one of them (LL-097/099). Carries the company
 * id so a page can name the company it resolves itself — never a free-text message reflected
 * from the URL (Gate 7 L1). A `LedgerError` with code PERIOD_CLOSED for every existing handler.
 */
export class PeriodClosedInCompanyError extends LedgerError {
  constructor(
    public readonly companyId: string,
    message: string,
  ) {
    super('PERIOD_CLOSED', message);
  }
}
