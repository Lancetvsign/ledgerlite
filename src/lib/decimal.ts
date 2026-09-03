import Decimal from 'decimal.js';

/**
 * Global decimal.js configuration — ADR-004. Imported for its side effect
 * wherever money is computed; configuring once keeps every calculation in the
 * app on identical rules.
 *
 *   precision 34  — comfortably exceeds NUMERIC(19,4), so intermediate results
 *                   in a multi-step sum never lose precision before the final
 *                   rounding.
 *   ROUND_HALF_EVEN — banker's rounding, the accounting standard: half-way
 *                     cases split evenly rather than accumulating the upward
 *                     bias ROUND_HALF_UP produces across many values.
 */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

/** The scale money is stored and compared at: NUMERIC(19,4). */
export const MONEY_SCALE = 4;

/** A money string ("10000.0000", "0", "-5.5") — the boundary form (ADR-004). */
export function toMoney(value: string): Decimal {
  return new Decimal(value);
}

/**
 * Exact equality at NUMERIC(19,4). Compares the values rounded to 4 places with
 * Decimal.eq — never `===`, never an epsilon. An epsilon is how an unbalanced
 * entry slips through.
 */
export function moneyEquals(a: Decimal, b: Decimal): boolean {
  return a.toDecimalPlaces(MONEY_SCALE).eq(b.toDecimalPlaces(MONEY_SCALE));
}

/** Sum money strings exactly, returning a Decimal at full precision. */
export function sumMoney(values: readonly string[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0));
}

export { Decimal };
