import { describe, expect, it } from 'vitest';

import { parseBack, selfHref, withBack } from '@/app/reports/back';

/** LL-115: "Back to report" — only our own report screens are ever linked back to. */
describe('parseBack', () => {
  it('accepts a report screen with its filters, and names it', () => {
    expect(parseBack('/reports/trial-balance?asOf=2026-09-27')).toEqual({ href: '/reports/trial-balance?asOf=2026-09-27', title: 'Trial Balance' });
    expect(parseBack('/reports/income-statement?from=2026-01-01&to=2026-09-27')?.title).toBe('Income Statement');
    expect(parseBack('/dashboard')).toEqual({ href: '/dashboard', title: 'Dashboard' });
  });

  it('refuses anything that is not one of our report screens', () => {
    for (const bad of [
      undefined,
      '',
      'https://evil.example/reports/trial-balance',
      '//evil.example/reports/trial-balance',
      '/\\evil.example/reports/trial-balance',
      '\\\\evil.example',
      'javascript:alert(1)',
      '/journal/new',
      '/reports/register?accountId=x',
      '/reports',
      '/reports/trial-balance/../../account',
      'reports/trial-balance',
      `/reports/trial-balance?asOf=${'9'.repeat(2100)}`,
      ['/reports/aging', '/reports/trial-balance'], // a repeated ?back= arrives as an array
      42,
    ]) {
      expect(parseBack(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });

  it('normalises what it returns to a path and query only', () => {
    expect(parseBack('/reports/aging?asOf=2026-09-27#fragment')).toEqual({ href: '/reports/aging?asOf=2026-09-27', title: 'A/R Aging' });
    expect(parseBack('/reports/./aging?asOf=2026-09-27')?.href).toBe('/reports/aging?asOf=2026-09-27');
  });
});

describe('selfHref and withBack', () => {
  it('builds the screen\'s own address, keeping only a valid parent', () => {
    expect(selfHref('/reports/trial-balance', { asOf: '2026-09-27' })).toBe('/reports/trial-balance?asOf=2026-09-27');
    expect(selfHref('/reports/income-statement', { from: '2026-01-01', to: '2026-09-27' }, '/reports/balance-sheet?asOf=2026-09-27')).toBe(
      '/reports/income-statement?from=2026-01-01&to=2026-09-27&back=%2Freports%2Fbalance-sheet%3FasOf%3D2026-09-27',
    );
    expect(selfHref('/reports/aging', { asOf: '2026-09-27' }, 'https://evil.example')).toBe('/reports/aging?asOf=2026-09-27');
  });

  it('a chain unwinds one step at a time', () => {
    const bs = selfHref('/reports/balance-sheet', { asOf: '2026-09-27' }, '/dashboard');
    const is = selfHref('/reports/income-statement', { from: '2026-01-01', to: '2026-09-27' }, bs);
    const back = parseBack(new URLSearchParams(withBack('/reports/register?accountId=a', is).split('?')[1]).get('back') ?? undefined);
    expect(back?.title).toBe('Income Statement');
    const toBs = parseBack(new URLSearchParams(back!.href.split('?')[1]).get('back') ?? undefined);
    expect(toBs).toEqual({ href: bs, title: 'Balance Sheet' });
    expect(parseBack(new URLSearchParams(toBs!.href.split('?')[1]).get('back') ?? undefined)?.title).toBe('Dashboard');
  });

  it('adds back to an address with or without a query; nothing when there is none', () => {
    expect(withBack('/reports/register?accountId=a', '/dashboard')).toBe('/reports/register?accountId=a&back=%2Fdashboard');
    expect(withBack('/reports/aging', '/dashboard')).toBe('/reports/aging?back=%2Fdashboard');
    expect(withBack('/reports/aging', undefined)).toBe('/reports/aging');
  });
});
