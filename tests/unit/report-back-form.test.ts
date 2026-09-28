import { describe, expect, it } from 'vitest';

import { backFrom } from '@/app/reports/back';

/** LL-120: an action keeps only a valid `back` its form carried. */
describe('backFrom', () => {
  const form = (entries: [string, string][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };
  it('returns the normalised address of one of our screens', () => {
    expect(backFrom(form([['back', '/reports/register?accountId=a&from=2026-01-01&to=2026-09-28#x']]))).toBe('/reports/register?accountId=a&from=2026-01-01&to=2026-09-28');
  });
  it('returns nothing for a missing, foreign or crafted value', () => {
    expect(backFrom(form([]))).toBeUndefined();
    expect(backFrom(form([['back', 'https://evil.example/reports/register']]))).toBeUndefined();
    expect(backFrom(form([['back', '//evil.example/reports/aging']]))).toBeUndefined();
    expect(backFrom(form([['back', '/account']]))).toBeUndefined();
    const file = new FormData();
    file.append('back', new Blob(['/reports/register']), 'x.txt');
    expect(backFrom(file)).toBeUndefined(); // a file is never a way back
  });
});
