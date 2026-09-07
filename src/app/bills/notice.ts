/**
 * Map a bill `?error=`/`?…=1` code to a human notice — LL-065. Shared by the new and
 * detail pages so the wording stays in one place. Every code corresponds to a
 * `BillError`/`LedgerError` the actions can surface, or a success flag; anything
 * unrecognized falls through to a generic line. The A/P mirror of the invoice notice.
 */
export function billNotice(code: string | undefined): string | null {
  switch (code) {
    case undefined:
      return null;
    case 'finalized':
      return 'Bill finalized and posted to the ledger.';
    case 'voided':
      return 'Bill voided; its ledger entry was reversed.';
    case 'invalid':
      return 'Please check the bill and try again.';
    case 'denied':
      return 'You do not have permission for that.';
    case 'VENDOR_NOT_FOUND':
      return 'That vendor does not exist in this company.';
    case 'ACCOUNT_NOT_FOUND':
      return 'A line references an account that does not exist in this company.';
    case 'LINE_ACCOUNT_INVALID':
      return 'A bill line cannot post to a system control account (e.g. Accounts Payable).';
    case 'BILL_NOT_DRAFT':
      return 'Only a draft bill can be edited or finalized.';
    case 'BILL_NOT_OPEN':
      return 'Only an open bill can be voided.';
    case 'BILL_ZERO_TOTAL':
      return 'A zero-total bill cannot be finalized.';
    case 'BILL_HAS_PAYMENTS':
      return 'Void the payments applied to this bill before voiding it.';
    case 'BILL_HAS_ADJUSTMENTS':
      return 'Void the vendor credits applied to this bill before voiding it.';
    case 'AP_ACCOUNT_NOT_CONFIGURED':
      return 'No Accounts Payable account is configured for this company.';
    case 'PERIOD_CLOSED':
      return 'That date falls in a closed accounting period.';
    case 'BILL_NOT_FOUND':
    case 'notfound':
      return 'That bill was not found.';
    default:
      return 'That action could not be completed.';
  }
}
