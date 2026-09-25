import Decimal from 'decimal.js';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { toMoney } from '@/lib/decimal';

import type { StatementSummary } from '@/validation/bank-import';

/**
 * Statement-totals verification — LL-109. Pure: no I/O, no logging.
 *
 * A statement prints its own control figures — beginning balance, total credits, total
 * debits, ending balance. The extracted lines must add up to them, and the arithmetic
 * `beginning + credits − debits = ending` must hold. Each check runs only when its figures
 * are present; a statement that prints none is `not_stated`, never a mismatch. Money is
 * `string` in, Decimal to compute, `string` out — exact at NUMERIC(19,4) (ADR-004).
 *
 * Signs: line amounts are the import account's (positive = money in). Balances are in the
 * same convention (a card balance OWED is negative), so one rule serves banks and cards.
 */
export type VerificationStatus = 'verified' | 'mismatch' | 'not_stated';

export interface VerificationCheck {
  readonly name: 'credits' | 'debits' | 'ending_balance';
  /** What the statement states. */
  readonly expected: string;
  /** What the lines add up to (for ending_balance: beginning + credits − debits from the LINES). */
  readonly actual: string;
  /** actual − expected. */
  readonly difference: string;
  readonly ok: boolean;
}

export interface StatementVerification {
  readonly status: VerificationStatus;
  readonly checks: readonly VerificationCheck[];
  /** Σ of the positive line amounts. */
  readonly lineCredits: string;
  /** Σ |negative line amounts|. */
  readonly lineDebits: string;
}

function sums(amounts: readonly string[]): { credits: Decimal; debits: Decimal } {
  let credits = new Decimal(0);
  let debits = new Decimal(0);
  for (const a of amounts) {
    const m = toMoney(a);
    if (m.isPositive()) credits = credits.plus(m);
    else debits = debits.plus(m.abs());
  }
  return { credits, debits };
}

function check(name: VerificationCheck['name'], expected: string, actual: Decimal): VerificationCheck {
  const exp = toMoney(expected);
  return { name, expected: exp.toFixed(4), actual: actual.toFixed(4), difference: actual.minus(exp).toFixed(4), ok: actual.eq(exp) };
}

export function verifyStatementTotals(amounts: readonly string[], summary: StatementSummary | null | undefined): StatementVerification {
  const { credits, debits } = sums(amounts);
  const checks: VerificationCheck[] = [];
  if (summary?.totalCredits !== undefined) checks.push(check('credits', summary.totalCredits, credits));
  if (summary?.totalDebits !== undefined) checks.push(check('debits', summary.totalDebits, debits));
  if (summary?.beginningBalance !== undefined && summary.endingBalance !== undefined) {
    checks.push(check('ending_balance', summary.endingBalance, toMoney(summary.beginningBalance).plus(credits).minus(debits)));
  }
  const status: VerificationStatus = checks.length === 0 ? 'not_stated' : checks.every((c) => c.ok) ? 'verified' : 'mismatch';
  return { status, checks, lineCredits: credits.toFixed(4), lineDebits: debits.toFixed(4) };
}

/** The stored figures of a batch as a summary (null when the statement printed none). */
export function summaryOf(batch: {
  statedBeginningBalance: string | null;
  statedTotalCredits: string | null;
  statedTotalDebits: string | null;
  statedEndingBalance: string | null;
}): StatementSummary | null {
  const s: { -readonly [K in keyof StatementSummary]: StatementSummary[K] } = {};
  if (batch.statedBeginningBalance !== null) s.beginningBalance = batch.statedBeginningBalance;
  if (batch.statedTotalCredits !== null) s.totalCredits = batch.statedTotalCredits;
  if (batch.statedTotalDebits !== null) s.totalDebits = batch.statedTotalDebits;
  if (batch.statedEndingBalance !== null) s.endingBalance = batch.statedEndingBalance;
  return Object.keys(s).length === 0 ? null : s;
}
