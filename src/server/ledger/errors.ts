/**
 * LedgerService domain errors — stable, machine-readable codes. Tests assert on
 * the CODE, never on message text.
 */
export type LedgerErrorCode =
  | 'COMPANY_NOT_FOUND'
  | 'INACTIVE_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'PERIOD_CLOSED'
  /** A manual journal entry may not post to a control account (A/R or A/P) — a
   *  control account moves only through the documents its subsidiary can see
   *  (LL-050 / ADR-018 / ADR-023). */
  | 'CONTROL_ACCOUNT_MANUAL_POST'
  /** The manual posting API (`postJournalEntry`) accepts only `JOURNAL_ENTRY`; every
   *  other source type belongs to a document service that posts via `postEntryCore`
   *  (LL-066 / ADR-025). */
  | 'MANUAL_SOURCE_TYPE_REQUIRED'
  /** The manual reversal API (`reverseJournalEntry`) may reverse only a manual entry
   *  (a `JOURNAL_ENTRY`, or a reversal rooted in one). A document's entry — or a
   *  document void's reversal — must be undone through the document's own void, which
   *  keeps the subsidiary in step (LL-066 / ADR-025). */
  | 'DOCUMENT_REVERSAL_REQUIRES_VOID'
  | 'UNBALANCED_JOURNAL_ENTRY'
  /** The entry's per-side total exceeds the NUMERIC(19,4) ceiling (LL-052). */
  | 'ENTRY_AMOUNT_OUT_OF_RANGE'
  | 'INSUFFICIENT_LINES'
  | 'INVALID_LINE'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  // ---- LL-033: immutability & reversal ----
  /** A posted entry cannot be edited or deleted. Corrections are made by reversal. */
  | 'POSTED_ENTRY_IMMUTABLE'
  /** The entry to reverse does not exist in this company (same shape as a real
   *  miss — a cross-company id must not reveal that it exists elsewhere). */
  | 'ENTRY_NOT_FOUND'
  /** Only a POSTED entry can be reversed; a DRAFT is edited or discarded. */
  | 'ENTRY_NOT_POSTED'
  /** The entry has already been reversed — a second reversal would double-count. */
  | 'ENTRY_ALREADY_REVERSED';

export class LedgerError extends Error {
  public override readonly name = 'LedgerError';
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
  }
}
