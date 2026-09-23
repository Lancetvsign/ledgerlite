/**
 * The system-account roles the product depends on structurally (LL-042, LL-068, LL-096).
 * `accounts.system_account_type` is TEXT in the database (it extends without a type
 * migration); this module is the single place that names the values and answers the two
 * questions every picker and service used to answer with its own hand-written list.
 */
export const SYSTEM_ACCOUNT_TYPES = [
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'RETAINED_EARNINGS',
  'OPENING_BALANCE_EQUITY',
  'SALES_TAX_PAYABLE',
  /** "Due from <B>" in company A — the asset side of an intercompany pair (LL-096). */
  'INTERCOMPANY_RECEIVABLE',
  /** "Due to <A>" in company B — the liability side of the same pair. */
  'INTERCOMPANY_PAYABLE',
] as const;

export type SystemAccountType = (typeof SYSTEM_ACCOUNT_TYPES)[number];

export const INTERCOMPANY_TYPES: ReadonlySet<string> = new Set(['INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE']);

export function isIntercompanyType(systemAccountType: string | null): boolean {
  return systemAccountType !== null && INTERCOMPANY_TYPES.has(systemAccountType);
}

/**
 * May a user choose this account as a CATEGORY for a bank-import line or an opening
 * balance? Never a control account (A/R, A/P — they move only through documents), never
 * the two plugs (Retained Earnings moves only at year-end; Opening Balance Equity is the
 * opening-balance offset itself), never an intercompany account (it moves only through an
 * INTERCOMPANY posting). Sales Tax Payable is an ordinary category.
 */
export function isCategoryPostable(systemAccountType: string | null): boolean {
  if (systemAccountType === null) return true;
  return systemAccountType === 'SALES_TAX_PAYABLE';
}

/**
 * May this account carry an OPENING balance? Retained Earnings may (the prior years' result
 * at conversion); the control accounts may not (enter the open invoices and bills instead);
 * Opening Balance Equity is the offset itself; an intercompany account moves only through an
 * INTERCOMPANY posting.
 */
export function isOpeningBalanceTarget(systemAccountType: string | null): boolean {
  if (systemAccountType === null) return true;
  return !(
    systemAccountType === 'ACCOUNTS_RECEIVABLE' ||
    systemAccountType === 'ACCOUNTS_PAYABLE' ||
    systemAccountType === 'OPENING_BALANCE_EQUITY' ||
    INTERCOMPANY_TYPES.has(systemAccountType)
  );
}

/**
 * May this account receive or pay CASH for a customer payment / bill payment? Same
 * answer as above minus the plugs, which are not assets anyway: never a control account,
 * never an intercompany account.
 */
export function isCashUsable(systemAccountType: string | null): boolean {
  if (systemAccountType === null) return true;
  return !(
    systemAccountType === 'ACCOUNTS_RECEIVABLE' ||
    systemAccountType === 'ACCOUNTS_PAYABLE' ||
    INTERCOMPANY_TYPES.has(systemAccountType)
  );
}
