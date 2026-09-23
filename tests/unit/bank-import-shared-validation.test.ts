import { describe, expect, it } from 'vitest';

import { assignSharedLinesInput, postImportLinesInput, stageImportInput } from '@/validation/bank-import';
import { toLineAction } from '@/app/bank-import/[batchId]/review-state';

const ID = '00000000-0000-4000-8000-000000000001';

describe('LL-097 inputs', () => {
  it('accepts the personal decision and the share flag', () => {
    expect(postImportLinesInput.parse({ decisions: [{ lineId: ID, action: 'personal', accountId: ID }] }).decisions[0]!.action).toBe('personal');
    expect(stageImportInput.parse({ bankAccountId: ID, fileBytes: new Uint8Array(), shareWithOrganization: true }).shareWithOrganization).toBe(true);
    expect(stageImportInput.parse({ bankAccountId: ID, fileBytes: new Uint8Array() }).shareWithOrganization).toBeUndefined();
  });
  it('assign needs a line and an account per decision, and at least one', () => {
    expect(assignSharedLinesInput.safeParse({ decisions: [] }).success).toBe(false);
    expect(assignSharedLinesInput.safeParse({ decisions: [{ lineId: ID }] }).success).toBe(false);
    expect(assignSharedLinesInput.safeParse({ decisions: [{ lineId: ID, accountId: 'nope' }] }).success).toBe(false);
    expect(assignSharedLinesInput.parse({ decisions: [{ lineId: ID, accountId: ID }] }).decisions).toHaveLength(1);
  });
  it('the review state knows personal', () => {
    expect(toLineAction('personal')).toBe('personal');
    expect(toLineAction('garbage')).toBe('post');
  });
});
