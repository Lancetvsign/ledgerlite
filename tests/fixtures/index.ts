/**
 * Deterministic synthetic test data.
 *
 * RULES, enforced by tests/unit/fixtures.test.ts:
 *
 * 1. NEVER real customer, company, or financial data. Not anonymised real data —
 *    synthetic data. Anonymisation fails, and a test fixture is the least
 *    guarded artifact in the repository.
 * 2. Money is ALWAYS a string. A fixture containing `1000.50` as a JavaScript
 *    number would seed float error into the tests meant to prove we have none.
 *    See docs/DECISIONS.md ADR-004.
 * 3. Identifiers are FIXED, never random. A test that fails one run in fifty
 *    because of a generated value is a test people learn to re-run instead of
 *    read.
 * 4. Dates are fixed ISO calendar strings, never `new Date()`. See ADR-005.
 */

/** Fixed UUIDs. Readable suffixes so a failure message says which entity. */
export const IDS = {
  companyA: '00000000-0000-4000-8000-00000000000a',
  companyB: '00000000-0000-4000-8000-00000000000b',
  userA: '00000000-0000-4000-8000-0000000000a1',
  userB: '00000000-0000-4000-8000-0000000000b1',
} as const;

/** Fixed calendar dates. Chosen to straddle a period boundary and a year end. */
export const DATES = {
  midJanuary: '2026-01-15',
  endOfJanuary: '2026-01-31',
  startOfFebruary: '2026-02-01',
  endOfFiscalYear: '2026-12-31',
} as const;

/**
 * Monetary amounts, as strings at NUMERIC(19,4) scale.
 *
 * `awkward*` exist because they are the values a float implementation gets
 * wrong: 0.1 + 0.2 !== 0.3, and 0.3333 * 3 !== 1.
 */
export const MONEY = {
  zero: '0.0000',
  tenThousand: '10000.0000',
  fiveHundred: '500.0000',
  awkwardTenth: '0.1000',
  awkwardFifth: '0.2000',
  awkwardThird: '0.3333',
  awkwardThirdRemainder: '0.3334',
  large: '999999999999999.9999',
} as const;

/** Every monetary constant, for the meta-test that asserts none is a number. */
export const ALL_MONEY_VALUES: readonly unknown[] = Object.values(MONEY);
