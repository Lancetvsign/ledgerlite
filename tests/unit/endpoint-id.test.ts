import { describe, expect, it } from 'vitest';

import { endpointIdFromConnectionString } from '@/db/env';

const ID = 'ep-synthetic-fixture-0000';
const POOLED = `postgresql://u:p@${ID}-pooler.c-11.us-east-1.aws.neon.tech/neondb`;
const DIRECT = `postgresql://u:p@${ID}.c-11.us-east-1.aws.neon.tech/neondb`;

describe('endpointIdFromConnectionString', () => {
  it('strips the -pooler suffix', () => {
    expect(endpointIdFromConnectionString(POOLED)).toBe(ID);
  });

  it('returns the same id for the direct endpoint', () => {
    expect(endpointIdFromConnectionString(DIRECT)).toBe(ID);
  });

  it('yields ONE allowlist entry that matches BOTH hostnames', () => {
    // The property that matters. Keeping "-pooler" produced an entry that matched
    // the application's connection but not the migration runner's, so setup
    // looked complete and db:migrate failed later, far from the cause.
    const entry = endpointIdFromConnectionString(POOLED);
    expect(new URL(POOLED).hostname).toContain(entry);
    expect(new URL(DIRECT).hostname).toContain(entry);
  });

  it('does not strip -pooler from the middle of a label', () => {
    expect(
      endpointIdFromConnectionString('postgresql://u:p@ep-pooler-town-42.neon.tech/db'),
    ).toBe('ep-pooler-town-42');
  });

  it('falls back to the raw string when the URL is malformed', () => {
    expect(endpointIdFromConnectionString('ep-foo-pooler')).toBe('ep-foo');
  });
});
