import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { sumMoney, toMoney } from '@/lib/decimal';

/**
 * Consolidated statements — LL-122 (ADR-047): how accounts of different member companies line up
 * as one worksheet row. Pure (no database), so it is unit-tested directly.
 *
 * Owner's rule (2026-09-28): combine by ACCOUNT NUMBER; control and equity accounts by their SYSTEM
 * ROLE (a renumbered A/R still combines); an account without a number stays on its own row per
 * company. A number used for accounts of different TYPES never combines across types (a 1000 Checking
 * and a 1000 expense are not one line). Intercompany pair accounts are never ordinary rows — they are
 * eliminated (see consolidated.ts).
 */

export const INTERCOMPANY_ROLES: ReadonlySet<string> = new Set(['INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE']);

export interface KeyableAccount {
  readonly companyId: string;
  readonly accountId: string;
  readonly accountNumber: string | null;
  readonly accountName: string;
  readonly accountType: string;
  readonly systemAccountType: string | null;
}

/** The worksheet row an account belongs to, or null for an intercompany pair account (eliminated). */
export function consolidationKey(a: KeyableAccount): string | null {
  if (a.systemAccountType !== null && INTERCOMPANY_ROLES.has(a.systemAccountType)) return null;
  if (a.systemAccountType !== null) return `role:${a.systemAccountType}`;
  const n = a.accountNumber?.trim() ?? '';
  if (n !== '') return `num:${n}:${a.accountType}`;
  return `acct:${a.companyId}:${a.accountId}`;
}

export interface ConsolidatedRow {
  readonly key: string;
  /** The active company's name for this row, else the first member's; an unnumbered row names its company. */
  readonly label: string;
  /** The account number shown (the active company's, else the first member's), or null. */
  readonly accountNumber: string | null;
  /** Every distinct name the members use for this row (more than one = named differently). */
  readonly names: readonly string[];
  /** The number is used for accounts of another type too, so those stay on a separate row. */
  readonly numberSharedAcrossTypes: boolean;
  /** Amount per member company (absent = no activity). */
  readonly byCompany: Readonly<Record<string, string>>;
  readonly elimination: string;
  /** Σ byCompany + elimination. */
  readonly total: string;
  /** The active company's account on this row, for drilling into its register; null if it has none. */
  readonly drillAccountId: string | null;
}

export interface AmountedAccount extends KeyableAccount {
  readonly amount: string;
}

/**
 * The numbers the members use for accounts of more than one type — over the WHOLE charts, not one
 * statement section (a 6990 asset and a 6990 expense never meet in the same section).
 */
export function numbersSharedAcrossTypes(chart: readonly Pick<KeyableAccount, 'accountNumber' | 'accountType' | 'systemAccountType'>[]): ReadonlySet<string> {
  const typesByNumber = new Map<string, Set<string>>();
  for (const a of chart) {
    const n = a.accountNumber?.trim() ?? '';
    if (n === '' || a.systemAccountType !== null) continue;
    const set = typesByNumber.get(n) ?? new Set<string>();
    set.add(a.accountType);
    typesByNumber.set(n, set);
  }
  return new Set([...typesByNumber].filter(([, types]) => types.size > 1).map(([n]) => n));
}

/**
 * One row per key, in a stable order: numbered rows by number, then named rows, then unnumbered
 * per-company rows. `members` is the display order (the active company first); `sharedNumbers` comes
 * from `numbersSharedAcrossTypes` over the members' whole charts.
 */
export function assembleRows(
  accounts: readonly AmountedAccount[],
  members: readonly { readonly id: string; readonly legalName: string }[],
  activeCompanyId: string,
  sharedNumbers: ReadonlySet<string> = new Set(),
): ConsolidatedRow[] {
  const order = new Map(members.map((m, i) => [m.id, i]));
  const legalName = new Map(members.map((m) => [m.id, m.legalName]));
  const groups = new Map<string, AmountedAccount[]>();
  for (const a of accounts) {
    const key = consolidationKey(a);
    if (key === null) continue;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  const rows: ConsolidatedRow[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((x, y) => (order.get(x.companyId) ?? 99) - (order.get(y.companyId) ?? 99));
    const lead = sorted.find((a) => a.companyId === activeCompanyId) ?? sorted[0]!;
    const byCompany: Record<string, string> = {};
    for (const a of sorted) byCompany[a.companyId] = toMoney(byCompany[a.companyId] ?? '0').plus(toMoney(a.amount)).toFixed(4);
    const n = lead.accountNumber?.trim() ?? '';
    rows.push({
      key,
      label: key.startsWith('acct:') ? `${lead.accountName} (${legalName.get(lead.companyId) ?? 'another company'})` : lead.accountName,
      accountNumber: n === '' ? null : n,
      names: [...new Set(sorted.map((a) => a.accountName))],
      numberSharedAcrossTypes: n !== '' && lead.systemAccountType === null && sharedNumbers.has(n),
      byCompany,
      elimination: '0.0000',
      total: sumMoney(Object.values(byCompany)).toFixed(4),
      drillAccountId: sorted.find((a) => a.companyId === activeCompanyId)?.accountId ?? null,
    });
  }
  const rank = (r: ConsolidatedRow) => (r.key.startsWith('acct:') ? 2 : r.accountNumber === null ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.accountNumber ?? '').localeCompare(b.accountNumber ?? '', undefined, { numeric: true }) || a.label.localeCompare(b.label));
}
