import type { Decimal} from './decimal';
import { toMoney } from './decimal';

/**
 * Money DISPLAY — ADR-037. Storage and every computation stay at NUMERIC(19,4); the screen
 * shows two decimals with thousands separators, the way an accountant reads a figure.
 * String in → Decimal → string out (ADR-004): the value never touches a JS number, and
 * rounding to cents uses the global ROUND_HALF_EVEN. Formatting is presentation only —
 * anything that COMPARES money (a zero-difference check, a balance assertion) compares the
 * raw 4-dp strings or Decimals, never the formatted text.
 */

const DISPLAY_SCALE = 2;

/** `"1379.5000"` → `"1,379.50"`; `"-120.5"` → `"-120.50"`; `"0"` → `"0.00"`. */
export function formatMoney(value: string | Decimal): string {
  const d = typeof value === 'string' ? toMoney(value) : value;
  const fixed = d.toFixed(DISPLAY_SCALE); // half-even at cents
  // A value that rounds to zero is shown as 0.00, never -0.00 (LL-095).
  const unsigned = fixed.startsWith('-') ? fixed.slice(1) : fixed;
  const negative = unsigned !== fixed && /[1-9]/.test(unsigned);
  const [whole = '0', frac = '00'] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

/** The same figure as a plain input value: two decimals, no separators — what the validators accept. */
export function toInputAmount(value: string | Decimal): string {
  const d = typeof value === 'string' ? toMoney(value) : value;
  return d.toFixed(DISPLAY_SCALE);
}
