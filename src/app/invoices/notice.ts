/**
 * Map an invoice `?error=`/`?…=1` code to a human notice — LL-044. Shared by the
 * new, edit, and detail pages so the wording stays in one place. Every code here
 * corresponds to an `InvoiceError`/`LedgerError` the actions can surface, or a
 * success flag; anything unrecognized falls through to a generic line.
 */
export function invoiceNotice(code: string | undefined): string | null {
  switch (code) {
    case undefined:
      return null;
    case 'finalized':
      return 'Invoice finalized and posted to the ledger.';
    case 'voided':
      return 'Invoice voided; its ledger entry was reversed.';
    case 'invalid':
      return 'Please check the invoice and try again.';
    case 'denied':
      return 'You do not have permission for that.';
    case 'CUSTOMER_NOT_FOUND':
      return 'That customer does not exist in this company.';
    case 'ACCOUNT_NOT_FOUND':
      return 'A line references an account that does not exist in this company.';
    case 'INVOICE_NOT_DRAFT':
      return 'Only a draft invoice can be edited or finalized.';
    case 'INVOICE_NOT_OPEN':
      return 'Only an open invoice can be voided.';
    case 'INVOICE_ZERO_TOTAL':
      return 'A zero-total invoice cannot be finalized.';
    case 'INVOICE_HAS_PAYMENTS':
      return 'Void the payments applied to this invoice before voiding it.';
    case 'AR_ACCOUNT_NOT_CONFIGURED':
      return 'No Accounts Receivable account is configured for this company.';
    case 'TAX_ACCOUNT_NOT_CONFIGURED':
      return 'This invoice has tax but no Sales Tax Payable account is configured.';
    case 'PERIOD_CLOSED':
      return 'That date falls in a closed accounting period.';
    case 'INVOICE_NOT_FOUND':
    case 'notfound':
      return 'That invoice was not found.';
    default:
      return 'That action could not be completed.';
  }
}
