import { describe, expect, it } from 'vitest';

import { describeMigrationFailure } from '@/lib/migration-failure';

/** The shape drizzle raises: a wrapper with the SQL and params, the pg error as `cause`. */
function drizzleFailure(): Error {
  const pg = Object.assign(new Error('new row for relation "bank_import_lines" violates check constraint "bank_import_lines_assigned_shape"'), {
    code: '23514',
    constraint: 'bank_import_lines_assigned_shape',
    table: 'bank_import_lines',
    detail: 'Failing row contains (secret-data, 12.50).',
    hint: undefined,
  });
  const wrapper = Object.assign(new Error('Failed query: alter table "bank_import_lines" add constraint …\nparams: ["secret-value", 42]'), {
    query: 'alter table "bank_import_lines" add constraint …',
    params: ['secret-value', 42],
  });
  (wrapper as { cause?: unknown }).cause = pg;
  return wrapper;
}

describe('describeMigrationFailure', () => {
  it('shows the database verdict — message, code, constraint, table, detail — and the SQL', () => {
    const out = describeMigrationFailure(drizzleFailure());
    expect(out).toContain('MIGRATION FAILED');
    expect(out).toContain('violates check constraint "bank_import_lines_assigned_shape"');
    expect(out).toContain('code: 23514');
    expect(out).toContain('constraint: bank_import_lines_assigned_shape');
    expect(out).toContain('table: bank_import_lines');
    expect(out).toContain('detail: Failing row contains');
    expect(out).toContain('Failed query: alter table');
  });

  it('never echoes parameter values, only their count', () => {
    const out = describeMigrationFailure(drizzleFailure());
    expect(out).not.toContain('secret-value');
    expect(out).toContain('params: 2 value(s) (not shown)');
  });

  it('survives non-Error values and cause cycles', () => {
    expect(describeMigrationFailure('boom')).toBe('MIGRATION FAILED\n  boom');
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    const out = describeMigrationFailure(a);
    expect(out.split('\n')).toEqual(['MIGRATION FAILED', '  a', '  b']);
  });
});
