/**
 * Renders a migration failure for the console without leaking data.
 *
 * Drizzle wraps the driver's error: the top-level message is `Failed query: <sql>\nparams: …`
 * and the PostgreSQL error travels as `cause` (and may itself be wrapped again). What a
 * reader needs is the database's verdict — message, SQLSTATE code, the constraint, detail
 * and hint — which is exactly what a bare `error.message` hides. The SQL text is source
 * code and is shown; parameter VALUES are never shown (they can be data), only their count.
 */
interface PgErrorFields {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly detail?: unknown;
  readonly hint?: unknown;
  readonly table?: unknown;
  readonly column?: unknown;
  readonly query?: unknown;
  readonly params?: unknown;
  readonly cause?: unknown;
}

const FIELDS = ['code', 'constraint', 'table', 'column', 'detail', 'hint'] as const;

/** Strip the `params: …` tail drizzle appends to its message; values must not be echoed. */
function withoutParams(message: string): string {
  return message.replace(/\n?params:[\s\S]*$/u, '').trimEnd();
}

export function describeMigrationFailure(error: unknown): string {
  const lines: string[] = ['MIGRATION FAILED'];
  const seen = new Set<unknown>();
  let cur: unknown = error;
  let depth = 0;
  while (cur !== null && cur !== undefined && !seen.has(cur) && depth < 8) {
    seen.add(cur);
    depth += 1;
    if (typeof cur !== 'object') {
      lines.push(`  ${typeof cur === 'string' ? cur : (JSON.stringify(cur) ?? typeof cur)}`);
      break;
    }
    const e = cur as PgErrorFields;
    const message = typeof e.message === 'string' ? withoutParams(e.message) : '';
    if (message !== '') lines.push(`  ${message}`);
    for (const f of FIELDS) {
      const v = e[f];
      if (typeof v === 'string' && v !== '') lines.push(`    ${f}: ${v}`);
    }
    if (typeof e.query === 'string' && e.query !== '' && !message.includes(e.query)) lines.push(`    query: ${e.query.trim()}`);
    if (Array.isArray(e.params)) lines.push(`    params: ${String(e.params.length)} value(s) (not shown)`);
    cur = e.cause;
  }
  return lines.join('\n');
}
