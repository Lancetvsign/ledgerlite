'use client';

import { useState } from 'react';

import { closePeriodAction, reopenPeriodAction } from './actions';

/** Close/reopen with an explicit confirmation, per the ticket. */
export function PeriodActions({ periodId, status }: { periodId: string; status: 'OPEN' | 'CLOSED' }) {
  const [confirming, setConfirming] = useState(false);
  const action = status === 'OPEN' ? closePeriodAction : reopenPeriodAction;
  const label = status === 'OPEN' ? 'Close' : 'Reopen';

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setConfirming(true);
        }}
        className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
      >
        {label}
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="periodId" value={periodId} />
      <button type="submit" className="rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900">
        Confirm {label.toLowerCase()}
      </button>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
        }}
        className="text-xs text-neutral-500 underline"
      >
        Cancel
      </button>
    </form>
  );
}
