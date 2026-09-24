'use client';

import { useReviewState } from './review-state';

const SELECT = 'max-w-56 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

/**
 * The other company of an intercompany bank transfer (LL-099). Rendered for every staged
 * row so the form's per-row arrays stay aligned; visible only while the action is
 * "Transfer with another company". The service re-proves the company is a member the
 * reviewer may post in.
 */
export function LineCounterpartSelect({ index, options, initialId = null }: { index: number; options: readonly { id: string; legalName: string }[]; /** LL-105: the saved draft's counterpart. */ initialId?: string | null }) {
  const { actions } = useReviewState();
  const active = (actions[String(index)] ?? 'post') === 'intercompany_transfer';
  return (
    <select
      name="counterpartCompanyId"
      defaultValue={initialId ?? options[0]?.id ?? ''}
      data-testid={`import-counterpart-${String(index)}`}
      className={SELECT}
      hidden={!active}
      aria-label="Other company"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.legalName}</option>
      ))}
    </select>
  );
}
