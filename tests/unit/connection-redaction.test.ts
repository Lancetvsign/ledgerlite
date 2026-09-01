import { describe, expect, it } from 'vitest';

import { describeConnection } from '@/db/env';

const SECRET = 'SYNTHETIC-NOT-A-REAL-CREDENTIAL-0001';

describe('describeConnection', () => {
  it('removes the password entirely', () => {
    const out = describeConnection(
      `postgresql://neondb_owner:${SECRET}@ep-cool-fire-123.us-east-2.aws.neon.tech/ledgerlite?sslmode=require`,
    );
    expect(out).not.toContain(SECRET);
    expect(out).toBe('postgresql://neondb_owner@ep-cool-fire-123.us-east-2.aws.neon.tech/ledgerlite');
  });

  it('drops the query string, which can carry credentials of its own', () => {
    const out = describeConnection('postgresql://u:p@host/db?sslmode=require&options=secret');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('?');
  });

  it('keeps host and database, which are what diagnostics actually need', () => {
    const out = describeConnection('postgresql://u:p@ep-quiet-meadow-42.neon.tech/ledgerlite');
    expect(out).toContain('ep-quiet-meadow-42.neon.tech');
    expect(out).toContain('ledgerlite');
  });

  it('does not leak the password when the URL is malformed', () => {
    const out = describeConnection(`postgres://user:${SECRET}@@@not-a-url`);
    expect(out).not.toContain(SECRET);
  });

  it('never returns a masked password, whose length is itself a leak', () => {
    const out = describeConnection(`postgresql://u:${SECRET}@host/db`);
    expect(out).not.toMatch(/\*{2,}/);
    // No `user:anything@` remains — the credential is removed, not obscured.
    expect(out).not.toMatch(/\/\/[^/]*:[^/]*@/);
  });
});
