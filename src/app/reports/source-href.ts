import { isUuid } from '@/lib/uuid';

/**
 * Where "the source" of a posting lives (LL-084, extracted in LL-110 so the journal entry page
 * can point a document's entry at the document that owns its corrections). Falls back to the
 * journal entry's own page.
 */
export interface SourceRef {
  readonly entryId: string;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly reversalOfId: string | null;
  readonly bankImportBatchId: string | null;
}

export function sourceHref(l: SourceRef): string {
  const id = l.sourceId !== null && isUuid(l.sourceId) ? l.sourceId : null;
  switch (l.sourceType) {
    case 'INVOICE':
      return id !== null ? `/invoices/${id}` : `/journal/${l.entryId}`;
    case 'EXPENSE':
      return id !== null ? `/bills/${id}` : `/journal/${l.entryId}`;
    case 'CUSTOMER_PAYMENT':
      return id !== null ? `/payments/${id}` : `/journal/${l.entryId}`;
    case 'BILL_PAYMENT':
      return id !== null ? `/bill-payments/${id}` : `/journal/${l.entryId}`;
    case 'BANK_IMPORT':
    case 'INTERCOMPANY':
      return l.bankImportBatchId !== null ? `/bank-import/${l.bankImportBatchId}` : `/journal/${l.entryId}`;
    case 'REVERSAL':
      return l.reversalOfId !== null ? `/journal/${l.reversalOfId}` : `/journal/${l.entryId}`;
    default:
      return `/journal/${l.entryId}`;
  }
}
