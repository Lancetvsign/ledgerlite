/**
 * Free-text category → chart account (LL-080, hardened by LL-084).
 *
 * The model is told to answer with an account number or exact name, but in practice it
 * says things like "6300 · Office Supplies", "Office supplies", "Rent (6500)" or
 * "Advertising and Marketing". Each of those is unambiguous to a human, so it must be
 * unambiguous here — otherwise the review screen shows a grey "suggested:" hint with an
 * EMPTY picker, and the reviewer re-selects what the model already knew.
 *
 * Tiers, strictest first; a tier only answers when it identifies exactly one account:
 *  1. exact name or number (case-insensitive);
 *  2. an account number at the start of the text, or in parentheses anywhere;
 *  3. normalised name equality (punctuation-insensitive, "&" ≡ "and");
 *  4. containment: the text contains an account's normalised name (longest wins, ties
 *     refuse), or the text is a fragment found in exactly one account's name.
 * Pure and deterministic — the same text and chart always map the same way.
 */

export interface CategorizableAccount {
  readonly id: string;
  readonly accountNumber: string | null;
  readonly name: string;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberOf(a: CategorizableAccount): string | null {
  const n = a.accountNumber?.trim().toLowerCase() ?? '';
  return n === '' ? null : n;
}

export function mapCategoryToAccount(
  category: string | undefined,
  accounts: readonly CategorizableAccount[],
): string | null {
  if (category === undefined) return null;
  const raw = category.trim().toLowerCase();
  if (raw === '') return null;

  // 1. Exact name or number.
  const exact = accounts.find((a) => a.name.trim().toLowerCase() === raw || numberOf(a) === raw);
  if (exact !== undefined) return exact.id;

  // 2. Leading number token ("6300 · Office Supplies", "6300 - Rent", "6300: Rent"), or a
  //    number in parentheses ("Rent (6500)").
  const leading = /^([a-z0-9.-]+)(?:\s*[·•\-–—:|]\s*|\s+)\S/.exec(raw)?.[1];
  const parenthesised = /\(([a-z0-9.-]+)\)/.exec(raw)?.[1];
  for (const token of [leading, parenthesised]) {
    if (token === undefined) continue;
    const byNumber = accounts.filter((a) => numberOf(a) === token);
    if (byNumber.length === 1) return byNumber[0]!.id;
  }

  // 3. Normalised equality, with or without a leading number.
  const norm = normalize(raw);
  const stripped = leading !== undefined ? normalize(raw.slice(leading.length)) : norm;
  const byNorm = accounts.filter((a) => {
    const n = normalize(a.name);
    return n !== '' && (n === norm || n === stripped);
  });
  if (byNorm.length === 1) return byNorm[0]!.id;

  // 4a. The text CONTAINS an account name ("Expense: Office Supplies (monthly)"): the longest
  //     contained name wins; a tie on length is ambiguous.
  const named = accounts
    .map((a) => ({ a, n: normalize(a.name) }))
    .filter(({ n }) => n.length >= 3 && ` ${norm} `.includes(` ${n} `))
    .sort((x, y) => y.n.length - x.n.length);
  if (named.length > 0) {
    const best = named[0]!;
    return named.filter(({ n }) => n.length === best.n.length).length === 1 ? best.a.id : null;
  }

  // 4b. The text is a FRAGMENT of account names ("merchant fees"): only when exactly one
  //     account contains it — "revenue" matching two revenue accounts is no answer.
  const fragmentOf = accounts.filter((a) => {
    const n = normalize(a.name);
    return norm.length >= 3 && ` ${n} `.includes(` ${norm} `);
  });
  return fragmentOf.length === 1 ? fragmentOf[0]!.id : null;
}
