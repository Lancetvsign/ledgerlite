import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  log,
  newRequestId,
  setLogSink,
  withAdditionalContext,
  withRequestContext,
  type LogLevel,
} from '@/lib/logging';

let lines: { level: LogLevel; line: string }[] = [];
let restore: () => void;

beforeEach(() => {
  lines = [];
  process.env['LOG_FORMAT'] = 'json';
  process.env['LOG_LEVEL'] = 'debug';
  restore = setLogSink((level, line) => {
    lines.push({ level, line });
  });
});

afterEach(() => {
  restore();
  delete process.env['LOG_FORMAT'];
  delete process.env['LOG_LEVEL'];
});

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

const parsed = (i = 0): Record<string, unknown> => parseLine(lines[i]?.line ?? '{}');

describe('levels', () => {
  it('emits all four levels', () => {
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('suppresses below the configured level', () => {
    process.env['LOG_LEVEL'] = 'warn';
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('routes warn and error separately from info, so stderr is usable', () => {
    log.info('i');
    log.error('e');
    expect(lines[0]?.level).toBe('info');
    expect(lines[1]?.level).toBe('error');
  });
});

describe('correlation', () => {
  it('has no requestId outside a request context', () => {
    log.info('background job');
    expect(parsed()['requestId']).toBeUndefined();
  });

  it('attaches the requestId to every line inside a context', () => {
    const requestId = newRequestId();
    withRequestContext({ requestId }, () => {
      log.info('first');
      log.warn('second');
    });
    expect(parsed(0)['requestId']).toBe(requestId);
    expect(parsed(1)['requestId']).toBe(requestId);
  });

  it('propagates across async boundaries', async () => {
    // The property that makes this worth having: a log line emitted deep inside
    // an awaited call still carries the id, without it being threaded through
    // every intervening function signature.
    const requestId = newRequestId();
    await withRequestContext({ requestId }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      log.info('deep inside');
    });
    expect(parsed()['requestId']).toBe(requestId);
  });

  it('keeps concurrent requests separate', async () => {
    const a = newRequestId();
    const b = newRequestId();
    await Promise.all([
      withRequestContext({ requestId: a }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        log.info('from a');
      }),
      withRequestContext({ requestId: b }, async () => {
        await Promise.resolve();
        log.info('from b');
      }),
    ]);
    const byMessage = new Map<unknown, unknown>(
      lines.map((l) => {
        const rec = parseLine(l.line);
        return [rec['message'], rec['requestId']];
      }),
    );
    expect(byMessage.get('from a')).toBe(a);
    expect(byMessage.get('from b')).toBe(b);
  });

  it('adds userId and companyId once known, keeping the same requestId', () => {
    const requestId = newRequestId();
    withRequestContext({ requestId }, () => {
      withAdditionalContext({ userId: 'user-1', companyId: 'company-1' }, () => {
        log.info('authorized');
      });
    });
    expect(parsed()).toMatchObject({ requestId, userId: 'user-1', companyId: 'company-1' });
  });
});

describe('child loggers', () => {
  it('merges bound fields into every line', () => {
    const service = log.child({ service: 'LedgerService' });
    service.info('posting', { entryNumber: 41 });
    expect(parsed()).toMatchObject({ service: 'LedgerService', entryNumber: 41 });
  });

  it('lets a call-site field override a bound one', () => {
    log.child({ stage: 'validate' }).info('done', { stage: 'commit' });
    expect(parsed()['stage']).toBe('commit');
  });

  it('still redacts bound fields', () => {
    log.child({ password: 'bound-secret-value' }).info('event');
    expect(lines[0]?.line).not.toContain('bound-secret-value');
  });
});

describe('output format', () => {
  it('emits one JSON object per line when deployed', () => {
    log.info('event', { a: 1 });
    expect(() => {
      JSON.parse(lines[0]?.line ?? '');
    }).not.toThrow();
    expect(lines[0]?.line).not.toContain('\n');
    expect(parsed()).toMatchObject({ level: 'info', message: 'event', a: 1 });
  });

  it('includes an ISO timestamp', () => {
    log.info('event');
    expect(String(parsed()['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('emits a human-readable line in development', () => {
    delete process.env['LOG_FORMAT'];
    log.info('readable', { entryNumber: 41 });
    const line = lines[0]?.line ?? '';
    expect(() => {
      JSON.parse(line);
    }).toThrow();
    expect(line).toContain('INFO');
    expect(line).toContain('readable');
    expect(line).toContain('entryNumber');
  });
});
