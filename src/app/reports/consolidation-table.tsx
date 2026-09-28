import Link from 'next/link';

import { formatMoney } from '@/lib/money-format';

import type { ConsolidatedRow, ConsolidatedSection, ConsolidationMember } from '@/server/reports';

import { DrillLink, registerHref } from './drill';

/**
 * The consolidated worksheet — LL-122 (ADR-047). One row per account line, a column per member
 * company, Eliminations, Consolidated. Pure presentation over the service's strings (ADR-004): no
 * figure is computed here. The active company's cells drill into its register (the register is
 * scoped to the active company); other companies' cells are plain.
 */
export interface WorksheetBlock {
  readonly title: string;
  readonly testid: string;
  readonly section: ConsolidatedSection;
}

export interface WorksheetTotal {
  readonly label: string;
  readonly testid: string;
  readonly byCompany: Readonly<Record<string, string>>;
  readonly elimination?: string;
  readonly total: string;
}

const cell = 'py-1.5 pr-3 text-right tabular-nums';

function amount(v: string | undefined): string {
  return v === undefined ? '—' : formatMoney(v);
}

export function ConsolidationWorksheet({
  members,
  activeCompanyId,
  blocks,
  totals,
  drillFrom,
  drillTo,
  back,
  testid,
}: {
  members: readonly ConsolidationMember[];
  activeCompanyId: string;
  blocks: readonly WorksheetBlock[];
  totals: readonly WorksheetTotal[];
  drillFrom: string;
  drillTo: string;
  back: string;
  testid: string;
}) {
  const row = (r: ConsolidatedRow) => (
    <tr key={r.key} data-testid="consolidated-row" data-key={r.key} className="border-b border-neutral-100 dark:border-neutral-800">
      <td className="py-1.5 pr-3">
        {r.accountNumber !== null && <span className="mr-2 text-neutral-500 tabular-nums">{r.accountNumber}</span>}
        {r.label}
        {r.names.length > 1 && (
          <span className="ml-2 text-xs text-neutral-500" title={r.names.join(' · ')} data-testid="consolidated-names-differ">
            (named differently: {r.names.join(' · ')})
          </span>
        )}
        {r.numberSharedAcrossTypes && (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200" data-testid="consolidated-number-split">
            number also used for another account type
          </span>
        )}
      </td>
      {members.map((m) => (
        <td key={m.id} className={cell}>
          {m.id === activeCompanyId && r.drillAccountId !== null && r.byCompany[m.id] !== undefined ? (
            <DrillLink href={registerHref(r.drillAccountId, drillFrom, drillTo, back)} amount={r.byCompany[m.id]!} />
          ) : (
            amount(r.byCompany[m.id])
          )}
        </td>
      ))}
      <td className={`${cell} text-neutral-500`} data-testid="consolidated-elimination">{/^-?0(\.0+)?$/.test(r.elimination) ? '—' : formatMoney(r.elimination)}</td>
      <td className={`${cell} font-medium`} data-testid="consolidated-total">{formatMoney(r.total)}</td>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" data-testid={testid}>
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-3">Account</th>
            {members.map((m) => (
              <th key={m.id} className="py-2 pr-3 text-right" data-testid="consolidated-company-column">{m.legalName}</th>
            ))}
            <th className="py-2 pr-3 text-right">Eliminations</th>
            <th className="py-2 pr-3 text-right">Consolidated</th>
          </tr>
        </thead>
        {blocks.map((b) => (
          <tbody key={b.testid} data-testid={b.testid}>
            <tr>
              <td colSpan={members.length + 3} className="pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{b.title}</td>
            </tr>
            {b.section.rows.map(row)}
            <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
              <td className="py-1.5 pr-3">Total {b.title.toLowerCase()}</td>
              {members.map((m) => (
                <td key={m.id} className={cell}>{amount(b.section.byCompany[m.id])}</td>
              ))}
              <td className={`${cell} text-neutral-500`}>{/^-?0(\.0+)?$/.test(b.section.elimination) ? '—' : formatMoney(b.section.elimination)}</td>
              <td className={cell} data-testid={`${b.testid}-total`}>{formatMoney(b.section.total)}</td>
            </tr>
          </tbody>
        ))}
        <tbody>
          {totals.map((t) => (
            <tr key={t.testid} className="border-t-2 border-neutral-400 font-semibold dark:border-neutral-600">
              <td className="py-2 pr-3">{t.label}</td>
              {members.map((m) => (
                <td key={m.id} className={cell}>{amount(t.byCompany[m.id])}</td>
              ))}
              <td className={`${cell} text-neutral-500`}>{t.elimination === undefined || /^-?0(\.0+)?$/.test(t.elimination) ? '—' : formatMoney(t.elimination)}</td>
              <td className={cell} data-testid={t.testid}>{formatMoney(t.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why there is no worksheet: outside an organization, or not every member is visible to you. */
export function ConsolidationUnavailable({ code, companies }: { code: string; companies: readonly string[] }) {
  return (
    <p role="status" data-testid="consolidation-unavailable" data-code={code} className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
      {code === 'NOT_IN_ORGANIZATION' ? (
        <>This company is not in an organization, so there is nothing to consolidate. Organizations are set up on the <Link href="/account" className="underline">Account</Link> page.</>
      ) : (
        <>Consolidating needs access to every company in the organization. You cannot view: {companies.join(', ')}. Ask an owner of those companies to add you.</>
      )}
    </p>
  );
}
