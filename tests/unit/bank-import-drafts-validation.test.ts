import { describe, expect, it } from 'vitest';

import { saveReviewDraftsInput, saveSharedDraftsInput } from '@/validation/bank-import';

const ID = '00000000-0000-4000-8000-000000000001';

describe('LL-105 draft inputs', () => {
  it('a review draft carries the review actions and optional ids; an empty save is allowed', () => {
    expect(saveReviewDraftsInput.parse({ drafts: [] }).drafts).toHaveLength(0);
    const one = saveReviewDraftsInput.parse({ drafts: [{ lineId: ID, action: 'intercompany_transfer', counterpartCompanyId: ID }] }).drafts[0]!;
    expect(one).toMatchObject({ action: 'intercompany_transfer', counterpartCompanyId: ID });
    expect(one.accountId).toBeUndefined();
    expect(saveReviewDraftsInput.safeParse({ drafts: [{ lineId: ID, action: 'take' }] }).success).toBe(false); // the shared tick is not a review action
    expect(saveReviewDraftsInput.safeParse({ drafts: [{ lineId: 'nope', action: 'post' }] }).success).toBe(false);
  });
  it('a shared draft is a tick plus an optional account', () => {
    expect(saveSharedDraftsInput.parse({ drafts: [{ lineId: ID, take: true, accountId: ID }] }).drafts[0]).toMatchObject({ take: true, accountId: ID });
    expect(saveSharedDraftsInput.parse({ drafts: [{ lineId: ID, take: false }] }).drafts[0]!.accountId).toBeUndefined();
    expect(saveSharedDraftsInput.safeParse({ drafts: [{ lineId: ID, take: 'yes' }] }).success).toBe(false);
  });
});
