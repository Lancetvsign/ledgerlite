/**
 * Map a bill-payment `?error=`/success code to a human notice — LL-065. Shared by the
 * new and detail pages. Each code corresponds to a `BillPaymentError`/`LedgerError` the
 * actions can surface, or a success flag; anything else falls through. The A/P mirror
 * of the payment notice.
 */
export function billPaymentNotice(code: string | undefined): string | null {
  switch (code) {
    case undefined:
      return null;
    case 'paid':
      return 'Bill payment made and posted to the ledger.';
    case 'voided':
      return 'Bill payment voided; its ledger entry was reversed.';
    case 'invalid':
      return 'Please check the payment and try again.';
    case 'denied':
      return 'You do not have permission for that.';
    case 'VENDOR_NOT_FOUND':
      return 'That vendor does not exist in this company.';
    case 'BILL_NOT_FOUND':
      return 'An applied bill does not exist in this company.';
    case 'BILL_NOT_OPEN':
      return 'An applied bill is no longer open.';
    case 'BILL_WRONG_VENDOR':
      return 'An applied bill belongs to a different vendor.';
    case 'OVERAPPLIED':
      return 'An amount applied exceeds the bill’s open balance.';
    case 'DUPLICATE_BILL_APPLICATION':
      return 'A bill was applied to more than once.';
    case 'CASH_ACCOUNT_INVALID':
      return 'Choose an active asset account (not a control account) to pay from.';
    case 'AP_ACCOUNT_NOT_CONFIGURED':
      return 'No Accounts Payable account is configured for this company.';
    case 'BILL_PAYMENT_NOT_POSTED':
      return 'Only a posted bill payment can be voided.';
    case 'PERIOD_CLOSED':
      return 'That date falls in a closed accounting period.';
    case 'BILL_PAYMENT_NOT_FOUND':
    case 'notfound':
      return 'That bill payment was not found.';
    default:
      return 'That action could not be completed.';
  }
}
