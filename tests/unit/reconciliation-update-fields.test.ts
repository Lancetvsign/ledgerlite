import { describe, expect, it } from 'vitest';

import { changedUpdateFields } from '@/app/reconciliation/update-fields';

describe('changedUpdateFields (LL-093 / Gate 6 M4)', () => {
  const shown = { shownDate: '2026-06-30', shownAmount: '1000.00' };

  it('sends nothing when the reviewer changed nothing — the 4-dp stored figure is never rewritten', () => {
    expect(changedUpdateFields({ statementDate: '2026-06-30', statementEndingAmount: '1000.00', ...shown })).toEqual({});
  });

  it('sends only the date when only the date changed', () => {
    expect(changedUpdateFields({ statementDate: '2026-07-31', statementEndingAmount: '1000.00', ...shown })).toEqual({ statementDate: '2026-07-31' });
  });

  it('sends the amount when the reviewer typed a new one, at whatever precision they typed', () => {
    expect(changedUpdateFields({ statementDate: '2026-06-30', statementEndingAmount: '1000.0050', ...shown })).toEqual({ statementEndingAmount: '1000.0050' });
  });

  it('treats a missing field as unchanged', () => {
    expect(changedUpdateFields({ statementDate: undefined, statementEndingAmount: undefined, ...shown })).toEqual({});
  });
});
