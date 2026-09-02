import { describe, expect, it } from 'vitest';

import { createCompanyInput } from '@/validation/company';

const VALID = {
  legalName: 'Synthetic Coffee LLC',
  timezone: 'America/Chicago',
};

describe('createCompanyInput', () => {
  it('accepts a minimal valid company and applies defaults', () => {
    const parsed = createCompanyInput.parse(VALID);
    expect(parsed.fiscalYearStartMonth).toBe(1);
    expect(parsed.currencyCode).toBe('USD');
  });

  it.each([
    ['missing legal name', { ...VALID, legalName: undefined }],
    ['blank legal name', { ...VALID, legalName: '   ' }],
    ['fiscal month 0', { ...VALID, fiscalYearStartMonth: 0 }],
    ['fiscal month 13', { ...VALID, fiscalYearStartMonth: 13 }],
    ['fractional fiscal month', { ...VALID, fiscalYearStartMonth: 1.5 }],
    ['lowercase currency', { ...VALID, currencyCode: 'usd' }],
    ['two-letter currency', { ...VALID, currencyCode: 'US' }],
    ['invented timezone', { ...VALID, timezone: 'Mars/Olympus_Mons' }],
    ['missing timezone', { legalName: 'X' }],
  ])('rejects %s', (_label, input) => {
    expect(createCompanyInput.safeParse(input).success).toBe(false);
  });

  it('never accepts an ein through general creation', () => {
    // The protected column has no path through this schema at all.
    const parsed = createCompanyInput.parse({ ...VALID });
    expect('ein' in parsed).toBe(false);
    expect(Object.keys(createCompanyInput.shape)).not.toContain('ein');
  });
});
