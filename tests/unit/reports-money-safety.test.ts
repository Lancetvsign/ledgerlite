import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Money-safety guard for the reporting UI — LL-055.
 *
 * The report screens render money by printing the service's `string` values
 * verbatim (ADR-004): a JS `number` must never hold a monetary value, not even
 * "just for the UI". This test statically forbids the coercions that would do it
 * — `Number(...)`, `parseFloat(...)`, `parseInt(...)`, unary-plus (`+total`), and
 * multiply-by-one (`total * 1`) — anywhere under `src/app/reports`. It is a grep,
 * not a type check: cheap, and it fails loudly the moment someone reaches for a
 * coercion to format or re-sum a money value.
 */
const REPORTS_DIR = join(process.cwd(), 'src/app/reports');
const FORBIDDEN: readonly RegExp[] = [
  /\bNumber\s*\(/,
  /\bparseFloat\s*\(/,
  /\bparseInt\s*\(/,
  // Unary-plus coercion (`= +total`, `(+x`, `,+x`, `[+x`, `{+x` in JSX) — the `+`
  // sits in an operand position (after `= ( [ { ,`), never as a binary `a + b`.
  /[={([,]\s*\+\s*[A-Za-z_$.]/,
  // Multiply-by-one coercion (`total * 1`).
  /[\w$.)\]]\s*\*\s*1\b/,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('reporting UI never coerces money to a JS number (ADR-004)', () => {
  const files = sourceFiles(REPORTS_DIR);

  it('finds report component files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no numeric coercion of money under src/app/reports', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (FORBIDDEN.some((re) => re.test(src))) offenders.push(relative(process.cwd(), file));
    }
    expect(offenders).toEqual([]);
  });
});
