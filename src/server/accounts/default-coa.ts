import type { AccountType } from '@/validation/account';

/**
 * The default small-business chart of accounts — LL-023.
 *
 * A DETERMINISTIC, fixed set: the same numbers, names, types and subtypes every
 * time, so the installer is idempotent by keying on (company_id, account_number).
 * Numbering follows the conventional blocks:
 *   1000–1999 assets · 2000–2999 liabilities · 3000–3999 equity
 *   4000–4999 revenue · 5000–5999 COGS · 6000+ expenses
 *
 * NO balances, NO journal entries — this only defines account structure.
 */

export interface DefaultAccount {
  readonly accountNumber: string;
  readonly name: string;
  readonly accountType: AccountType;
  readonly accountSubtype: string;
  /**
   * Set for the accounts the product depends on structurally. These are created
   * by BOTH install paths, cannot be created through general account creation,
   * and cannot be deactivated (LL-020's service protection).
   */
  readonly systemAccountType?: string;
}

/**
 * The required system accounts — installed by every company regardless of which
 * chart it chose. The ledger cannot function without these three.
 */
export const REQUIRED_SYSTEM_ACCOUNTS: readonly DefaultAccount[] = [
  { accountNumber: '1100', name: 'Accounts Receivable', accountType: 'ASSET', accountSubtype: 'accounts_receivable', systemAccountType: 'ACCOUNTS_RECEIVABLE' },
  { accountNumber: '3900', name: 'Retained Earnings', accountType: 'EQUITY', accountSubtype: 'retained_earnings', systemAccountType: 'RETAINED_EARNINGS' },
  { accountNumber: '3000', name: 'Opening Balance Equity', accountType: 'EQUITY', accountSubtype: 'opening_balance_equity', systemAccountType: 'OPENING_BALANCE_EQUITY' },
] as const;

/**
 * The practical standard chart — the required system accounts PLUS everyday
 * accounts a small business expects. Includes the system accounts so the
 * standard install is a superset of the minimal one.
 */
export const STANDARD_CHART: readonly DefaultAccount[] = [
  ...REQUIRED_SYSTEM_ACCOUNTS,
  // Assets
  { accountNumber: '1000', name: 'Checking', accountType: 'ASSET', accountSubtype: 'bank' },
  { accountNumber: '1010', name: 'Savings', accountType: 'ASSET', accountSubtype: 'bank' },
  { accountNumber: '1200', name: 'Undeposited Funds', accountType: 'ASSET', accountSubtype: 'current_asset' },
  // Liabilities
  { accountNumber: '2000', name: 'Accounts Payable', accountType: 'LIABILITY', accountSubtype: 'accounts_payable' },
  { accountNumber: '2100', name: 'Credit Card', accountType: 'LIABILITY', accountSubtype: 'credit_card' },
  { accountNumber: '2200', name: 'Sales Tax Payable', accountType: 'LIABILITY', accountSubtype: 'current_liability', systemAccountType: 'SALES_TAX_PAYABLE' },
  // Equity
  { accountNumber: '3100', name: 'Owner Contributions', accountType: 'EQUITY', accountSubtype: 'owner_equity' },
  { accountNumber: '3200', name: 'Owner Distributions', accountType: 'EQUITY', accountSubtype: 'owner_equity' },
  // Revenue
  { accountNumber: '4000', name: 'Sales Revenue', accountType: 'REVENUE', accountSubtype: 'operating_revenue' },
  { accountNumber: '4100', name: 'Service Revenue', accountType: 'REVENUE', accountSubtype: 'operating_revenue' },
  // COGS
  { accountNumber: '5000', name: 'Cost of Goods Sold', accountType: 'COGS', accountSubtype: 'cogs' },
  // Operating expenses
  { accountNumber: '6000', name: 'Advertising & Marketing', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6100', name: 'Bank & Merchant Fees', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6200', name: 'Insurance', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6300', name: 'Office Supplies', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6400', name: 'Professional Fees', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6500', name: 'Rent', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6600', name: 'Software & Subscriptions', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6700', name: 'Travel & Meals', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6800', name: 'Utilities', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
  { accountNumber: '6900', name: 'Wages & Salaries', accountType: 'EXPENSE', accountSubtype: 'operating_expense' },
] as const;

export type CoaChoice = 'standard' | 'system-only';

export function chartFor(choice: CoaChoice): readonly DefaultAccount[] {
  return choice === 'standard' ? STANDARD_CHART : REQUIRED_SYSTEM_ACCOUNTS;
}
