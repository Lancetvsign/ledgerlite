/**
 * "Back to report" — LL-115. A drill-down link (LL-108) carries the address of the screen it
 * was clicked on as `back`; the screen it opens offers "← Back to <that report>" with the same
 * filters. LL-117: the account register is a source too — the journal entry and source document
 * a register row opens lead back to the register. A plain module (no JSX, no 'use client') so pages and unit tests share it.
 *
 * `back` arrives in the URL, so it is untrusted: only a same-origin path to one of the screens
 * below is honoured (never another origin, a protocol-relative `//host`, a backslash trick or an
 * arbitrary app path) — anything else is ignored and the page shows its usual "← Reports" only.
 */

/** The screens a drill-down can start from, by path, with the title the link shows. */
export const BACK_TITLES = {
  '/dashboard': 'Dashboard',
  '/reports/trial-balance': 'Trial Balance',
  '/reports/balance-sheet': 'Balance Sheet',
  '/reports/income-statement': 'Income Statement',
  '/reports/cash-flow': 'Cash-Flow Statement',
  '/reports/aging': 'A/R Aging',
  '/reports/ap-aging': 'A/P Aging',
  '/reports/intercompany': 'Intercompany Balances',
  // LL-117: the register's rows open journal entries and source documents, which lead back to it.
  '/reports/register': 'Account Register',
} as const;
export type BackPath = keyof typeof BACK_TITLES;

function titleOf(pathname: string): string | undefined {
  return Object.hasOwn(BACK_TITLES, pathname) ? BACK_TITLES[pathname as BackPath] : undefined;
}

/** Longer than any real chain of report addresses; a cap on what a crafted URL can make us echo. */
const MAX_BACK_LENGTH = 2000;
const BASE = 'https://ledgerlite.invalid';

export interface BackTarget {
  readonly href: string;
  readonly title: string;
}

/**
 * The screen to return to, or null when `raw` is absent or not one of ours. Typed `unknown`
 * because a query string can repeat a key (`?back=a&back=b` arrives as an array).
 */
export function parseBack(raw: unknown): BackTarget | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BACK_LENGTH) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const title = titleOf(url.pathname);
  if (title === undefined) return null;
  return { href: `${url.pathname}${url.search}`, title };
}

/**
 * The address of the screen being rendered — its path, its filters and, when it was itself
 * opened from a drill-down, its own valid `back` (so a chain unwinds one step at a time).
 */
export function selfHref(path: BackPath, params: Readonly<Record<string, string>>, back?: unknown): string {
  const q = new URLSearchParams(params);
  const parent = parseBack(back);
  if (parent !== null) q.set('back', parent.href);
  const s = q.toString();
  return s === '' ? path : `${path}?${s}`;
}

/** `href` with `back` added (href may or may not already carry a query). */
export function withBack(href: string, back: string | undefined): string {
  if (back === undefined) return href;
  return `${href}${href.includes('?') ? '&' : '?'}back=${encodeURIComponent(back)}`;
}

/**
 * LL-120: the valid `back` a form carried (its hidden `back` field, see `BackField`), for an action
 * to keep on the page it redirects to — or undefined. Never trusted beyond `parseBack`.
 */
export function backFrom(formData: FormData): string | undefined {
  return parseBack(formData.get('back'))?.href;
}
