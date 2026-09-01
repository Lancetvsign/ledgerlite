import { describe, expect, it } from 'vitest';

import {
  assertNotProductionByConfig,
  assertSafeForDestructiveUse,
  assertTestDatabaseMarker,
  UnsafeDatabaseError,
  type GuardEnvironment,
} from '@/db/safety';

const DEV_URL =
  'postgresql://neondb_owner:SYNTHETIC-PLACEHOLDER@ep-quiet-meadow-42.us-east-2.aws.neon.tech/ledgerlite';
const PROD_URL =
  'postgresql://neondb_owner:SYNTHETIC-PLACEHOLDER@ep-prod-thunder-9.us-east-2.aws.neon.tech/ledgerlite';

function env(overrides: Partial<GuardEnvironment> = {}): GuardEnvironment {
  return {
    connectionString: DEV_URL,
    appEnv: 'test',
    allowlist: 'ep-quiet-meadow-42',
    ...overrides,
  };
}

const markerPresent = (): Promise<boolean> => Promise.resolve(true);
const markerAbsent = (): Promise<boolean> => Promise.resolve(false);

describe('layer 1 — APP_ENV opt-in', () => {
  it('accepts APP_ENV=test', () => {
    expect(() => {
      assertNotProductionByConfig(env());
    }).not.toThrow();
  });

  it.each([
    ['undefined', undefined],
    ['development', 'development'],
    ['production', 'production'],
    ['preview', 'preview'],
    ['TEST (wrong case)', 'TEST'],
    ['empty string', ''],
  ])('refuses APP_ENV=%s', (_label, appEnv) => {
    expect(() => {
      assertNotProductionByConfig(env({ appEnv }));
    }).toThrow(UnsafeDatabaseError);
  });
});

describe('layer 2a — production-shaped targets', () => {
  it.each([
    ['prod in host', PROD_URL],
    ['production in database name', 'postgresql://u:p@ep-abc-1.neon.tech/production'],
    ['live in host', 'postgresql://u:p@db-live-1.neon.tech/ledgerlite'],
    ['master in database name', 'postgresql://u:p@ep-abc-1.neon.tech/master'],
  ])('refuses %s', (_label, connectionString) => {
    expect(() => {
      assertNotProductionByConfig(env({ connectionString, allowlist: 'neon.tech' }));
    }).toThrow(UnsafeDatabaseError);
  });

  it('does not false-positive on substrings inside longer words', () => {
    // "reproduce" contains "produ", "mainline" contains "main" — neither is production.
    expect(() => {
      assertNotProductionByConfig(
        env({
          connectionString: 'postgresql://u:p@ep-reproduce-mainline-7.neon.tech/ledgerlite',
          allowlist: 'ep-reproduce-mainline-7',
        }),
      );
    }).not.toThrow();
  });
});

describe('layer 2b — allowlist is mandatory and fails closed', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only whitespace and commas', ' , , '],
  ])('refuses when the allowlist is %s', (_label, allowlist) => {
    expect(() => {
      assertNotProductionByConfig(env({ allowlist }));
    }).toThrow(UnsafeDatabaseError);
  });

  it('refuses a host that is not on the allowlist', () => {
    expect(() => {
      assertNotProductionByConfig(env({ allowlist: 'ep-some-other-branch' }));
    }).toThrow(UnsafeDatabaseError);
  });

  it('accepts a host that is on the allowlist among several', () => {
    expect(() => {
      assertNotProductionByConfig(env({ allowlist: 'ep-other, ep-quiet-meadow-42 ,ep-third' }));
    }).not.toThrow();
  });
});

describe('layer 3 — the database must identify itself', () => {
  it('accepts a database carrying the marker', async () => {
    await expect(assertTestDatabaseMarker(markerPresent, DEV_URL)).resolves.toBeUndefined();
  });

  it('refuses a database without the marker', async () => {
    await expect(assertTestDatabaseMarker(markerAbsent, DEV_URL)).rejects.toThrow(
      UnsafeDatabaseError,
    );
  });

  it('fails closed when the probe itself errors', async () => {
    const probe = (): Promise<boolean> => Promise.reject(new Error('connection refused'));
    await expect(assertTestDatabaseMarker(probe, DEV_URL)).rejects.toThrow(UnsafeDatabaseError);
  });
});

describe('errors never leak the password', () => {
  const SECRET = 'SYNTHETIC-NOT-A-REAL-CREDENTIAL-0001';
  const withSecret = `postgresql://owner:${SECRET}@ep-prod-thunder-9.neon.tech/ledgerlite`;

  it('omits the credential from a denylist failure', () => {
    try {
      assertNotProductionByConfig(env({ connectionString: withSecret, allowlist: 'neon.tech' }));
      expect.unreachable('guard should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it('omits the credential from a marker failure', async () => {
    await expect(assertTestDatabaseMarker(markerAbsent, withSecret)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(SECRET) as unknown as string }),
    );
  });
});

describe('all layers together', () => {
  it('passes only when every layer passes', async () => {
    await expect(assertSafeForDestructiveUse(env(), markerPresent)).resolves.toBeUndefined();
  });

  it('refuses when config passes but the marker is missing', async () => {
    await expect(assertSafeForDestructiveUse(env(), markerAbsent)).rejects.toThrow(
      UnsafeDatabaseError,
    );
  });

  it('refuses on config before ever probing the database', async () => {
    let probed = false;
    const probe = (): Promise<boolean> => {
      probed = true;
      return Promise.resolve(true);
    };
    await expect(
      assertSafeForDestructiveUse(env({ appEnv: 'production' }), probe),
    ).rejects.toThrow(UnsafeDatabaseError);
    expect(probed).toBe(false);
  });
});
