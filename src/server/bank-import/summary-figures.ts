import Decimal from 'decimal.js';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { toMoney } from '@/lib/decimal';

import { normalizeAmount } from './normalize';

import type { StatementSummary } from '@/validation/bank-import';

/**
 * A statement's account-summary figures, read by their PRINTED LABELS — LL-123 (ADR-034 amendment).
 * Pure: no I/O, no logging.
 *
 * LL-109 let the model decide which printed number was the beginning balance, the total credits,
 * the total debits and the ending balance. On the owner's statement it put the right numbers in the
 * wrong slots ("Previous Balance" as total credits, "Balance This Statement" as total debits) and
 * nothing could catch it. Now the model reports every summary line WITH its label, and the app
 * decides each figure's role from the label wherever the label is unambiguous. Every figure must
 * also appear on the statement (its amount and its label, in the PDF text) — a figure the model
 * computed or invented is not counted. Summaries print categories (deposits, interest, other
 * credits; checks, card purchases, fees), so money in and money out are each the SUM of their lines.
 */

export type FigureRole = 'beginning' | 'ending' | 'money_in' | 'money_out';

/** What the model reported for one summary line. */
export interface RawFigure {
  readonly label: string;
  readonly amount: string;
  readonly role?: FigureRole | undefined;
}

export interface StatementFigure {
  /** As printed. */
  readonly label: string;
  /** The printed amount, canonical (`1,500.00 CR` → `1500.00`), or the raw text if it is not a money figure. */
  readonly amount: string;
  readonly role: FigureRole | null;
  /** 'label' — the app read the role from the label (overriding the model); 'model' — the label was ambiguous. */
  readonly source: 'label' | 'model';
  /** The amount and the label both occur in the statement text. Figures not found are not counted. */
  readonly found: boolean;
}

function words(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const BEGINNING = /\b(previous|beginning|opening|prior|starting|last statement|brought forward|balance forward)\b/;
const ENDING = /\b(ending|closing|new|current|this statement|statement balance|balance this)\b/;
const MONEY_IN = /\b(deposits?|credits?|additions?|interest (earned|paid)|refunds?|payments? received|incoming)\b/;
const MONEY_OUT = /\b(withdrawals?|debits?|checks?|cheques?|fees?|service charges?|purchases?|cash advances?|interest charged?|subtractions?|outgoing)\b/;

/** The role a printed label names unambiguously, or null (the model's role then stands). */
export function roleFromLabel(label: string): FigureRole | null {
  const l = words(label);
  if (/\bbalance\b/.test(l)) {
    const beginning = BEGINNING.test(l);
    const ending = ENDING.test(l);
    if (beginning !== ending) return beginning ? 'beginning' : 'ending';
    return null;
  }
  const moneyIn = MONEY_IN.test(l);
  const moneyOut = MONEY_OUT.test(l);
  if (moneyIn !== moneyOut) return moneyIn ? 'money_in' : 'money_out';
  return null;
}

/** Every money value printed in the text, as magnitudes at 4 decimals (`$9,554.08` → `9554.0800`). */
export function moneyValuesIn(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?|\d+\.\d{1,4}/g)) {
    out.add(new Decimal(m[0].replace(/,/g, '')).abs().toFixed(4));
  }
  return out;
}

function isMoney(s: string): boolean {
  return /^-?\d{1,15}(\.\d{1,4})?$/.test(s);
}

/**
 * Read the model's summary lines against the statement text. Returns the four totals the rest of
 * the app uses (in the import account's sign convention: a card balance OWED is negative) and every
 * figure with its role and whether it was found.
 */
export function readSummaryFigures(
  raw: readonly RawFigure[],
  text: string,
  statementKind: 'bank' | 'credit_card',
): { summary: StatementSummary; figures: StatementFigure[] } {
  const values = moneyValuesIn(text);
  const textWords = ` ${words(text)} `;
  const figures: StatementFigure[] = raw.map((f) => {
    const amount = normalizeAmount(f.amount);
    const labelled = roleFromLabel(f.label);
    const labelWords = words(f.label);
    const found = isMoney(amount) && values.has(new Decimal(amount).abs().toFixed(4)) && labelWords !== '' && textWords.includes(` ${labelWords} `);
    return { label: f.label.trim(), amount, role: labelled ?? f.role ?? null, source: labelled !== null ? 'label' : 'model', found };
  });

  const counted = figures.filter((f) => f.found);
  const balance = (role: FigureRole): string | undefined => {
    const f = counted.find((x) => x.role === role);
    if (f === undefined) return undefined;
    const printed = toMoney(f.amount);
    // A card's printed balance is what is OWED; the import convention makes that negative. A
    // balance printed as a credit (CR, or already negative) is money the card owes back.
    if (statementKind === 'credit_card') {
      const rawText = raw[figures.indexOf(f)]?.amount ?? '';
      return (/\bCR\b/i.test(rawText) ? printed : printed.negated()).toFixed(4);
    }
    return printed.toFixed(4);
  };
  const total = (role: FigureRole): string | undefined => {
    const lines = counted.filter((x) => x.role === role);
    if (lines.length === 0) return undefined;
    return lines.reduce((sum, x) => sum.plus(toMoney(x.amount).abs()), new Decimal(0)).toFixed(4);
  };

  const summary: { -readonly [K in keyof StatementSummary]: StatementSummary[K] } = {};
  const beginning = balance('beginning');
  const ending = balance('ending');
  const moneyIn = total('money_in');
  const moneyOut = total('money_out');
  if (beginning !== undefined) summary.beginningBalance = beginning;
  if (moneyIn !== undefined) summary.totalCredits = moneyIn;
  if (moneyOut !== undefined) summary.totalDebits = moneyOut;
  if (ending !== undefined) summary.endingBalance = ending;
  return { summary, figures };
}
