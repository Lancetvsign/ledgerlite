import { describe, expect, it } from 'vitest';

import { isCashUsable, isCategoryPostable, isIntercompanyType, isOpeningBalanceTarget, SYSTEM_ACCOUNT_TYPES } from '@/server/accounts/system-roles';

/** The single source of truth for "may a user pick this system account here" — LL-096. */
describe('system-roles', () => {
  it('names every role the product depends on', () => {
    expect([...SYSTEM_ACCOUNT_TYPES]).toEqual([
      'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'RETAINED_EARNINGS', 'OPENING_BALANCE_EQUITY', 'SALES_TAX_PAYABLE',
      'INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE',
    ]);
  });

  it.each([
    // type, category-postable (bank import), opening-balance target, cash-usable (deposit / bill payment)
    [null, true, true, true],
    ['SALES_TAX_PAYABLE', true, true, true],
    ['ACCOUNTS_RECEIVABLE', false, false, false],
    ['ACCOUNTS_PAYABLE', false, false, false],
    ['RETAINED_EARNINGS', false, true, true],
    ['OPENING_BALANCE_EQUITY', false, false, true],
    ['INTERCOMPANY_RECEIVABLE', false, false, false],
    ['INTERCOMPANY_PAYABLE', false, false, false],
  ] as const)('%s → category %s, opening %s, cash %s', (type, category, opening, cash) => {
    expect(isCategoryPostable(type)).toBe(category);
    expect(isOpeningBalanceTarget(type)).toBe(opening);
    expect(isCashUsable(type)).toBe(cash);
    expect(isIntercompanyType(type)).toBe(type === 'INTERCOMPANY_RECEIVABLE' || type === 'INTERCOMPANY_PAYABLE');
  });
});
