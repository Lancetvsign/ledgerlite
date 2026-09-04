/**
 * Map a payment `?error=`/success code to a human notice — LL-045. Shared by the
 * new and detail pages. Each code corresponds to a `PaymentError`/`LedgerError`
 * the actions can surface, or a success flag; anything else falls through.
 */
export function paymentNotice(code: string | undefined): string | null {
  switch (code) {
    case undefined:
      return null;
    case 'received':
      return 'Payment received and posted to the ledger.';
    case 'voided':
      return 'Payment voided; its ledger entry was reversed.';
    case 'invalid':
      return 'Please check the payment and try again.';
    case 'denied':
      return 'You do not have permission for that.';
    case 'CUSTOMER_NOT_FOUND':
      return 'That customer does not exist in this company.';
    case 'INVOICE_NOT_FOUND':
      return 'An applied invoice does not exist in this company.';
    case 'INVOICE_NOT_OPEN':
      return 'An applied invoice is no longer open.';
    case 'INVOICE_WRONG_CUSTOMER':
      return 'An applied invoice belongs to a different customer.';
    case 'OVERAPPLIED':
      return 'An amount applied exceeds the invoice’s open balance.';
    case 'DUPLICATE_INVOICE_APPLICATION':
      return 'An invoice was applied to more than once.';
    case 'DEPOSIT_ACCOUNT_INVALID':
      return 'Choose an active asset account (not Accounts Receivable) to deposit into.';
    case 'AR_ACCOUNT_NOT_CONFIGURED':
      return 'No Accounts Receivable account is configured for this company.';
    case 'PAYMENT_NOT_POSTED':
      return 'Only a posted payment can be voided.';
    case 'PERIOD_CLOSED':
      return 'That date falls in a closed accounting period.';
    case 'PAYMENT_NOT_FOUND':
    case 'notfound':
      return 'That payment was not found.';
    default:
      return 'That action could not be completed.';
  }
}
