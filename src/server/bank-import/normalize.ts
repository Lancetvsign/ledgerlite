/**
 * Normalise what the model returns BEFORE strict validation — LL-076 hardening.
 *
 * The extractor asks for `YYYY-MM-DD` dates and signed plain-decimal amounts, but models
 * (and statements) habitually write `$1,500.00`, `(120.50)`, `120.50-`, `1,500.00 CR` or
 * `06/03/2026`. The strict validator in `stageImport` rejects every one of those, and a
 * single bad row rejects the whole batch by design. This step maps the common notations to
 * the canonical form and NOTHING else: anything still not a clean money string / calendar
 * date is left as-is for the validator to reject. Pure functions, no I/O, no logging.
 */

const CURRENCY = /[$€£]/g;
/** Unsigned decimal, optionally with US thousands separators: 1500, 1,500.00, 0.5 */
const UNSIGNED = /^(\d{1,3}(,\d{3})+|\d{1,15})(\.\d{1,4})?$/;

/**
 * `"$1,500.00"` → `"1500.00"`; `"(120.50)"` / `"120.50-"` / `"-$120.50"` / `"120.50 DR"` →
 * `"-120.50"`; `"1,500.00 CR"` → `"1500.00"`; `"+40"` → `"40"`. Anything else — including
 * European `1 500,00` / `1.500,00`, which would be silently WRONG if commas were just
 * stripped — is returned untouched for the validator to reject.
 */
export function normalizeAmount(raw: string): string {
  let s = raw.trim();
  let negative = false;

  // Accounting parentheses: (120.50) means −120.50.
  const paren = /^\((.+)\)$/.exec(s);
  if (paren?.[1] !== undefined) {
    negative = true;
    s = paren[1].trim();
  }
  // Credit/debit suffixes some banks print: DR = money out, CR = money in.
  const crdr = /^(.+?)\s*(CR|DR)$/i.exec(s);
  if (crdr?.[1] !== undefined && crdr[2] !== undefined) {
    s = crdr[1].trim();
    if (crdr[2].toUpperCase() === 'DR') negative = !negative;
  }
  // Currency symbols may sit before or after the sign: -$120.50, $-120.50.
  s = s.replace(CURRENCY, '').trim();
  // Trailing minus: 120.50-
  if (s.length > 1 && s.endsWith('-') && !s.slice(0, -1).includes('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  // Leading sign: -120.50 / +40
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  // Only emit a canonical string when what remains is a plain unsigned decimal (with at
  // most US-style thousands separators); otherwise hand the original back.
  if (!UNSIGNED.test(s)) return raw;
  const plain = s.replace(/,/g, '');
  return negative ? `-${plain}` : plain;
}

/** `"06/03/2026"` or `"6-3-2026"` (US month-first) → `"2026-06-03"`; ISO passes through. */
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (us?.[1] !== undefined && us[2] !== undefined && us[3] !== undefined) {
    return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  return raw;
}

export interface RawExtractedRow {
  readonly date: string;
  readonly description: string;
  readonly amount: string;
  readonly category?: string | undefined;
}

export function normalizeExtractedRow(row: RawExtractedRow): RawExtractedRow {
  return {
    date: normalizeDate(row.date),
    description: row.description.trim(),
    amount: normalizeAmount(row.amount),
    ...(row.category !== undefined ? { category: row.category.trim() } : {}),
  };
}
