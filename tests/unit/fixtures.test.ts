import { describe, expect, it } from 'vitest';

import { ALL_MONEY_VALUES, DATES, IDS, MONEY } from '../fixtures';

describe('fixture conventions', () => {
  it('expresses every monetary value as a string, never a number', () => {
    for (const value of ALL_MONEY_VALUES) {
      expect(typeof value).toBe('string');
    }
  });

  it('holds four decimal places on every monetary value', () => {
    for (const value of Object.values(MONEY)) {
      expect(value).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it('keeps precision a float would lose', () => {
    // Why these fixtures are strings: the same amounts as JavaScript numbers do
    // not sum correctly. 0.1 + 0.2 is 0.30000000000000004.
    expect(Number(MONEY.awkwardTenth) + Number(MONEY.awkwardFifth)).not.toBe(0.3);

    // As strings they are exactly what was written, and stay that way.
    expect(MONEY.awkwardTenth).toBe('0.1000');
    expect(MONEY.awkwardFifth).toBe('0.2000');
  });

  it('uses fixed identifiers rather than generated ones', () => {
    expect(IDS.companyA).not.toBe(IDS.companyB);
    for (const id of Object.values(IDS)) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('uses fixed calendar dates, not timestamps', () => {
    for (const date of Object.values(DATES)) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
