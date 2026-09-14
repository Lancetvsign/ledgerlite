/**
 * Which accounts a statement can be imported into or reconciled against (LL-081, LL-088):
 * an ACTIVE cash/bank asset, or an ACTIVE credit-card liability (`accountSubtype =
 * 'credit_card'`, as the standard chart marks it). One predicate, shared by Bank Import,
 * Reconciliation and their account pickers so all of them agree.
 */
export function isStatementAccount(a: {
  status: string;
  accountType: string;
  cashFlowCategory: string | null;
  accountSubtype: string | null;
}): boolean {
  if (a.status !== 'ACTIVE') return false;
  if (a.accountType === 'ASSET' && a.cashFlowCategory === 'CASH') return true;
  return a.accountType === 'LIABILITY' && a.accountSubtype === 'credit_card';
}
