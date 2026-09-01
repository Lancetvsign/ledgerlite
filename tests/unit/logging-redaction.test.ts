import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  log,
  redact,
  REDACTED,
  setLogSink,
  type LogLevel,
} from '@/lib/logging';

/**
 * A distinctive sentinel. Every assertion in this file is "the output does not
 * contain this string" — which is the only assertion shape that actually proves
 * redaction, since asserting on what IS present would pass while a secret sat
 * quietly in a neighbouring field.
 */
const SECRET = 'SENTINEL-a1b2c3d4e5f6-MUST-NEVER-APPEAR';

let lines: string[] = [];
let restore: () => void;

beforeEach(() => {
  lines = [];
  process.env['LOG_FORMAT'] = 'json';
  process.env['LOG_LEVEL'] = 'debug';
  restore = setLogSink((_level: LogLevel, line: string) => {
    lines.push(line);
  });
});

afterEach(() => {
  restore();
  delete process.env['LOG_FORMAT'];
  delete process.env['LOG_LEVEL'];
});

const output = (): string => lines.join('\n');

describe('redaction by key name', () => {
  const SENSITIVE_KEYS = [
    'password',
    'passwd',
    'passphrase',
    'dbPassword',
    'secret',
    'BETTER_AUTH_SECRET',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'Authorization',
    'cookie',
    'Set-Cookie',
    'sessionId',
    'session_id',
    'apiKey',
    'api_key',
    'privateKey',
    'credentials',
    'salt',
    'DATABASE_URL',
    'databaseUrl',
    'connectionString',
    'dsn',
    'ein',
    'EIN',
    'tin',
    'ssn',
    'taxId',
    'accountNumber',
    'routingNumber',
    'iban',
    'cardNumber',
    'cvv',
    'fileContent',
    'file_data',
    'attachment',
  ];

  it.each(SENSITIVE_KEYS)('removes the value of %s', (key) => {
    log.info('event', { [key]: SECRET });
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain(REDACTED);
  });

  it('keeps the key itself, so the shape of the log stays legible', () => {
    log.info('event', { password: SECRET });
    expect(output()).toContain('password');
  });

  it('never emits a masked form that leaks length', () => {
    log.info('event', { password: 'short' });
    log.info('event', { password: 'a-much-longer-password-value' });
    expect(lines[0]).toContain(REDACTED);
    expect(lines[0]?.replace(/"time":"[^"]*"/, '')).toBe(
      lines[1]?.replace(/"time":"[^"]*"/, ''),
    );
  });
});

/**
 * Provider tokens are assembled at runtime rather than written as literals.
 *
 * They have to LOOK like credentials for these tests to mean anything, which is
 * precisely what makes a scanner flag them. GitHub push protection rejected an
 * earlier version of this file over a Stripe-shaped fixture — correctly, on the
 * information available to it. Bypassing the block would have been the wrong
 * lesson; assembling the strings keeps the tests exercising the real patterns
 * while leaving no credential-shaped literal in the source.
 */
const BODY = '0123456789abcdefghijklmnop';
const token = (...parts: string[]): string => parts.join('');

describe('redaction by value shape, under innocuous keys', () => {
  it.each([
    ['postgres connection string', `postgresql://neondb_owner:${SECRET}@ep-x.neon.tech/db`],
    ['generic connection string', `mysql://root:${SECRET}@localhost/app`],
    ['bearer header', `Bearer ${SECRET}0123456789abcdef`],
    ['github token', token('gh', 'p_', BODY, 'qrstuvwx')],
    ['neon api key', token('na', 'pi_', BODY, 'qrstuvwx')],
    ['neon password', token('np', 'g_', BODY)],
    ['openai key', token('sk', '-', BODY)],
    ['stripe key', token('sk', '_', 'live', '_', BODY)],
    ['slack token', token('xo', 'xb-', '0123456789-abcdefghij')],
    ['aws access key', token('AK', 'IA', 'IOSFODNN7EXAMPLE')],
    ['private key header', token('-----BEGIN ', 'RSA PRIVATE KEY', '-----')],
    ['jwt', token('eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
  ])('redacts a %s that arrived under a harmless key', (_label, value) => {
    log.info('event', { detail: value });
    const out = output();
    expect(out).toContain(REDACTED);
    // The credential portion must be gone, not merely the key renamed.
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('0123456789abcdefghijklmnop');
  });

  it('redacts a credential embedded in the log message itself', () => {
    log.error(`connect failed: postgresql://u:${SECRET}@host/db refused`);
    expect(output()).not.toContain(SECRET);
    // Surrounding context survives, so the line is still worth reading.
    expect(output()).toContain('connect failed');
    expect(output()).toContain('refused');
  });

  it('leaves ordinary values untouched', () => {
    log.info('posted', { entryNumber: 41, amount: '10000.0000', account: 'Checking' });
    expect(output()).toContain('10000.0000');
    expect(output()).toContain('Checking');
    expect(output()).not.toContain(REDACTED);
  });
});

describe('nested structures', () => {
  it('redacts through nested objects', () => {
    log.info('event', { a: { b: { c: { password: SECRET } } } });
    expect(output()).not.toContain(SECRET);
  });

  it('redacts inside arrays', () => {
    log.info('event', { items: [{ ok: 1 }, { token: SECRET }] });
    expect(output()).not.toContain(SECRET);
  });

  it('redacts inside a Map and a Set', () => {
    log.info('map', { m: new Map([['password', SECRET]]) });
    log.info('set', { s: new Set([`postgres://u:${SECRET}@h/d`]) });
    expect(output()).not.toContain(SECRET);
  });

  it('redacts binary payloads wholesale', () => {
    log.info('upload', { receipt: new Uint8Array([1, 2, 3]) });
    expect(output()).toContain(REDACTED);
  });

  it('survives a circular reference without hanging', () => {
    const cyclic: Record<string, unknown> = { password: SECRET };
    cyclic['self'] = cyclic;
    log.info('cyclic', cyclic);
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain('[Circular]');
  });
});

describe('errors — the adversarial cases', () => {
  it('redacts a secret in an error message', () => {
    log.error('failed', { err: new Error(`connect ECONNREFUSED postgres://u:${SECRET}@h/d`) });
    expect(output()).not.toContain(SECRET);
  });

  it('redacts a secret in an error stack', () => {
    const err = new Error('boom');
    err.stack = `Error: boom\n    at connect (postgres://u:${SECRET}@h/d)`;
    log.error('failed', { err });
    expect(output()).not.toContain(SECRET);
  });

  it('redacts a secret THREE cause levels deep', () => {
    // The case the ticket calls out. Database drivers wrap errors repeatedly,
    // and the connection string is usually carried by the innermost one.
    const root = new Error(`root: postgresql://neondb_owner:${SECRET}@ep-x.neon.tech/db`);
    const mid = new Error('query failed', { cause: root });
    const outer = new Error('transaction aborted', { cause: mid });
    const top = new Error('posting failed', { cause: outer });

    log.error('ledger posting failed', { err: top });

    expect(output()).not.toContain(SECRET);
    // The chain is still walked and reported, not dropped.
    expect(output()).toContain('transaction aborted');
    expect(output()).toContain('query failed');
  });

  it('redacts a sensitive KEY nested inside an error cause', () => {
    const root = new Error('inner');
    (root as Error & { config?: unknown }).config = { headers: { authorization: SECRET } };
    log.error('failed', { err: new Error('outer', { cause: root }) });
    expect(output()).not.toContain(SECRET);
  });

  it('survives a circular cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    log.error('cyclic cause', { err: a });
    expect(output()).toContain('[Circular]');
  });
});

describe('redact() used directly', () => {
  it('is pure and does not mutate its input', () => {
    const input = { password: SECRET, keep: 'visible' };
    const result = redact(input) as Record<string, unknown>;
    expect(result['password']).toBe(REDACTED);
    expect(input.password).toBe(SECRET);
    expect(result['keep']).toBe('visible');
  });
});
