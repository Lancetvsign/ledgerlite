import { describe, expect, it } from 'vitest';

import { mapCategoryToAccount } from '@/server/bank-import/categorize';

const CHART = [
  { id: 'supplies', accountNumber: '6300', name: 'Office Supplies' },
  { id: 'rent', accountNumber: '6500', name: 'Rent' },
  { id: 'ads', accountNumber: '6000', name: 'Advertising & Marketing' },
  { id: 'fees', accountNumber: '6100', name: 'Bank & Merchant Fees' },
  { id: 'sales', accountNumber: '4000', name: 'Sales Revenue' },
  { id: 'service', accountNumber: '4100', name: 'Service Revenue' },
  { id: 'unnumbered', accountNumber: null, name: 'Petty Cash' },
];

describe('mapCategoryToAccount (LL-084)', () => {
  it.each([
    ['exact name', 'Office Supplies', 'supplies'],
    ['exact name, different case and padding', '  office supplies ', 'supplies'],
    ['exact number', '6500', 'rent'],
    ['number · name', '6300 · Office Supplies', 'supplies'],
    ['number - name', '6300 - Office Supplies', 'supplies'],
    ['number: name', '6500: Rent', 'rent'],
    ['number then name, plain space', '6500 Rent', 'rent'],
    ['name (number)', 'Rent (6500)', 'rent'],
    ['ampersand spelled out', 'Advertising and Marketing', 'ads'],
    ['punctuation and case differences', 'bank and merchant fees.', 'fees'],
    ['unnumbered account by name', 'petty cash', 'unnumbered'],
    ['name inside a longer phrase', 'Expense: Office Supplies (monthly)', 'supplies'],
    ['partial phrase contained in the name', 'merchant fees', 'fees'],
  ])('maps %s', (_label, category, expected) => {
    expect(mapCategoryToAccount(category, CHART)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['empty', '   '],
    ['unknown account', 'Travel & Meals'],
    ['unknown number', '9999'],
    ['ambiguous containment (two revenue accounts)', 'Revenue'],
  ])('returns null for %s rather than guessing', (_label, category) => {
    expect(mapCategoryToAccount(category, CHART)).toBeNull();
  });

  it('is deterministic when two accounts share a name: neither the exact nor the fuzzy tier picks between them', () => {
    const twins = [
      { id: 'a', accountNumber: '6300', name: 'Supplies' },
      { id: 'b', accountNumber: '6310', name: 'Supplies' },
    ];
    expect(mapCategoryToAccount('Supplies', twins)).toBe('a'); // exact tier keeps chart order (lowest number first)
    expect(mapCategoryToAccount('6310 · Supplies', twins)).toBe('b'); // the number disambiguates
    expect(mapCategoryToAccount('office supplies', twins)).toBeNull(); // fuzzy tier refuses a tie
  });
});
