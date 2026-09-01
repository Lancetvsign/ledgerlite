import { describe, expect, it } from 'vitest';

import { isPooledEndpoint } from '@/db/env';

const BRANCH = 'ep-quiet-meadow-a1b2c3d4';

describe('isPooledEndpoint', () => {
  it('detects a Neon pooler hostname', () => {
    expect(
      isPooledEndpoint(`postgresql://u:p@${BRANCH}-pooler.us-east-2.aws.neon.tech/db`),
    ).toBe(true);
  });

  it('does not flag the direct endpoint of the same branch', () => {
    expect(isPooledEndpoint(`postgresql://u:p@${BRANCH}.us-east-2.aws.neon.tech/db`)).toBe(
      false,
    );
  });

  it('is not fooled by "-pooler" appearing in the database name', () => {
    // Only the HOST decides. A database called "pooler-notes" is not a pooled endpoint.
    expect(
      isPooledEndpoint(`postgresql://u:p@${BRANCH}.neon.tech/pooler-notes`),
    ).toBe(false);
  });

  it('falls back to a substring check when the URL is malformed', () => {
    expect(isPooledEndpoint('not-a-url-but-has-pooler-in-it')).toBe(true);
    expect(isPooledEndpoint('not-a-url')).toBe(false);
  });
});
