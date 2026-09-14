/**
 * Which accounts a statement can be imported into or reconciled against (LL-081, LL-088,
 * LL-091): an ACTIVE, non-system cash/bank asset, or an ACTIVE, non-system credit-card liability (`accountSubtype =
 * 'credit_card'`, as the standard chart marks it). One predicate, shared by Bank Import,
 * Reconciliation and their account pickers so all of them agree.
 */
export function isStatementAccount(a: {
  status: string;
  accountType: string;
  cashFlowCategory: string | null;
  accountSubtype: string | null;
  systemAccountType: string | null;
}): boolean {
  if (a.status !== 'ACTIVE') return false;
  // A system account (A/R, A/P, Retained Earnings, OBE, Sales Tax) is never a statement
  // account, whatever its subtype or cash-flow section says (LL-091 / Gate 6 H2).
  if (a.systemAccountType !== null) return false;
  if (a.accountType === 'ASSET' && a.cashFlowCategory === 'CASH') return true;
  return a.accountType === 'LIABILITY' && a.accountSubtype === 'credit_card';
}
