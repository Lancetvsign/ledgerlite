import { z } from 'zod';

import { toMoney } from '@/lib/decimal';
import { formatMoney } from '@/lib/money-format';
import { statementFiguresSchema } from '@/validation/bank-import';

import { BackField } from '@/app/reports/drill';

import type { StatementVerification } from '@/server/bank-import';

import { amendStatementSummaryAction } from '../actions';
import { reanalysisNote } from '../reanalysis-note';

/**
 * The statement's own figures against the lines — LL-109, reworked by LL-123 (ADR-034 amendment).
 * A server component (no client JS). Shows what was READ from the statement's account summary (each
 * line with its printed label and the role the app gave it), the statement's own math, the lines'
 * math, and a form to correct the four totals when they were misread. Money is rendered from the
 * service's strings; nothing is computed here except display signs.
 */

const ROLE_TEXT: Record<string, string> = {
  beginning: 'beginning balance',
  ending: 'ending balance',
  money_in: 'money in',
  money_out: 'money out',
};

const CHECK_TEXT = {
  statement_math: 'Statement math: beginning + money in − money out',
  credits: 'Money in: the lines vs the statement',
  debits: 'Money out: the lines vs the statement',
  ending_balance: 'Ending balance from the lines: beginning + lines in − lines out',
} as const;

const amendedFromSchema = z.object({
  statedBeginningBalance: z.string().nullable(),
  statedTotalCredits: z.string().nullable(),
  statedTotalDebits: z.string().nullable(),
  statedEndingBalance: z.string().nullable(),
});

const INPUT = 'w-28 rounded border border-neutral-300 px-2 py-0.5 text-right text-xs dark:border-neutral-700 dark:bg-neutral-900';

export function StatementVerificationPanel({
  batchId,
  v,
  attempts,
  reanalysisFailure,
  figuresJson,
  amendedFromJson,
  stated,
  isCard,
  back,
}: {
  batchId: string;
  v: StatementVerification;
  attempts: number;
  reanalysisFailure: string | null;
  figuresJson: unknown;
  amendedFromJson: unknown;
  stated: { beginning: string | null; credits: string | null; debits: string | null; ending: string | null };
  isCard: boolean;
  back: string | undefined;
}) {
  const failedRecheck = v.status === 'mismatch' ? reanalysisNote(reanalysisFailure) : null;
  const figuresParsed = statementFiguresSchema.safeParse(figuresJson);
  const figures = figuresJson === null || !figuresParsed.success ? null : figuresParsed.data;
  const amendedParsed = amendedFromSchema.safeParse(amendedFromJson);
  const amendedFrom = amendedFromJson === null || !amendedParsed.success ? null : amendedParsed.data;
  // A card's balance owed is stored negative (import convention) and printed positive.
  const asPrinted = (stored: string | null) => (stored === null ? '' : (isCard ? toMoney(stored).negated() : toMoney(stored)).toFixed(2));
  const tone =
    v.status === 'verified'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100'
      : v.status === 'mismatch'
        ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100'
        : 'border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300';

  return (
    <section data-testid="statement-verification" data-status={v.status} className={`rounded border px-3 py-2 text-sm ${tone}`}>
      <p className="font-medium">
        {v.status === 'verified'
          ? 'Verified — the statement\'s own figures add up, and the lines add up to them.'
          : v.status === 'mismatch'
            ? 'Mismatch — the figures below do not all add up.'
            : 'The statement\'s summary figures were not read, so there is nothing to check the lines against.'}
        {attempts > 1 && <span className="ml-1 font-normal text-xs" data-testid="verification-attempts">(re-analysed once)</span>}
      </p>

      {figures !== null && figures.length > 0 && (
        // LL-123: what was read from the statement's account summary, by its printed labels.
        <div className="mt-1" data-testid="statement-figures">
          <p className="text-xs font-medium">Read from the statement</p>
          <ul className="text-xs">
            {figures.map((f, i) => (
              <li key={i} data-testid="statement-figure" data-role={f.role ?? ''} data-found={f.found ? '1' : '0'} className="flex flex-wrap gap-x-2">
                <span>{f.label}</span>
                <span className="tabular-nums">{/^-?\d+(\.\d+)?$/.test(f.amount) ? formatMoney(f.amount) : f.amount}</span>
                <span className="text-neutral-500">→ {f.role === null ? 'unassigned' : ROLE_TEXT[f.role]}{f.source === 'model' ? ' (the AI\'s reading — the label does not say)' : ''}</span>
                {!f.found && <span className="rounded bg-amber-100 px-1 text-amber-800 dark:bg-amber-900 dark:text-amber-200" data-testid="statement-figure-not-found">not on the statement — not counted</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {v.checks.length > 0 && (
        <table className="mt-1 w-full text-xs">
          <tbody>
            {v.checks.map((c) => (
              <tr key={c.name} data-testid={`verification-check-${c.name}`} data-ok={c.ok ? '1' : '0'}>
                <td className="py-0.5 pr-2">{CHECK_TEXT[c.name]}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{c.name === 'statement_math' ? 'comes to' : 'lines'} {formatMoney(c.actual)}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">statement {formatMoney(c.expected)}</td>
                <td className="py-0.5 text-right tabular-nums font-medium">{c.ok ? '✓' : `off by ${formatMoney(c.difference)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {failedRecheck !== null && (
        // LL-118: the re-check was tried and failed (LL-114 kept the first reading).
        <p className="mt-1 text-xs font-medium" data-testid="verification-reanalysis-failed">
          {failedRecheck}
        </p>
      )}
      {v.status === 'mismatch' && (
        <p className="mt-1 text-xs">
          If the statement math is off, a summary figure was misread — correct it below. If only the lines are off, correct a
          misread amount, date or description with “Edit line”, or ignore a line that is not a transaction; this panel updates as
          you go.
        </p>
      )}
      {amendedFrom !== null && (
        <p className="mt-1 text-xs" data-testid="statement-summary-amended">
          Summary figures corrected by a reviewer (read as: beginning {asPrinted(amendedFrom.statedBeginningBalance) || '—'}, in{' '}
          {amendedFrom.statedTotalCredits ?? '—'}, out {amendedFrom.statedTotalDebits ?? '—'}, ending {asPrinted(amendedFrom.statedEndingBalance) || '—'}).
        </p>
      )}

      <details className="mt-1">
        <summary className="cursor-pointer text-xs underline" data-testid="amend-summary-open">Correct the statement&apos;s figures</summary>
        {/* LL-123: a form of its own — never nested in the review form. */}
        <form action={amendStatementSummaryAction} className="mt-1 flex flex-wrap items-end gap-2 text-xs" data-testid="amend-summary-form">
          <input type="hidden" name="batchId" value={batchId} />
          <BackField back={back} />
          <label className="flex flex-col">
            <span>Beginning balance</span>
            <input name="beginningBalance" defaultValue={asPrinted(stated.beginning)} required inputMode="decimal" data-testid="amend-summary-beginning" className={INPUT} />
          </label>
          <label className="flex flex-col">
            <span>+ Money in</span>
            <input name="totalCredits" defaultValue={stated.credits === null ? '' : toMoney(stated.credits).toFixed(2)} required inputMode="decimal" data-testid="amend-summary-in" className={INPUT} />
          </label>
          <label className="flex flex-col">
            <span>− Money out</span>
            <input name="totalDebits" defaultValue={stated.debits === null ? '' : toMoney(stated.debits).toFixed(2)} required inputMode="decimal" data-testid="amend-summary-out" className={INPUT} />
          </label>
          <label className="flex flex-col">
            <span>= Ending balance</span>
            <input name="endingBalance" defaultValue={asPrinted(stated.ending)} required inputMode="decimal" data-testid="amend-summary-ending" className={INPUT} />
          </label>
          <button type="submit" data-testid="amend-summary-save" className="rounded border border-neutral-300 px-2 py-0.5 dark:border-neutral-700">Save</button>
          <span className="basis-full text-neutral-500">
            Enter the figures exactly as the statement prints them{isCard ? ' (the balance you owe as a positive number)' : ''}.
          </span>
        </form>
      </details>
    </section>
  );
}
