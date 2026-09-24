'use client';

import { useState } from 'react';

import { useReviewState } from './review-state';

const SELECT = 'max-w-72 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

export interface CounterpartOption {
  /** `line:<statementLineId>:<companyId>` for a match found on the other company's statement, `company:<id>` for a plain pick. */
  readonly value: string;
  readonly label: string;
}

/**
 * The other side of an intercompany movement (LL-099, LL-106). Rendered for every staged row so
 * the form's per-row arrays stay aligned; visible only while the action is the transfer. The
 * options are the other members' statement lines that mirror this one — found, not guessed —
 * with the plain company picker as a last resort; the empty option means the line WAITS for the
 * other company's statement (saved as a draft, skipped by the submit). The service re-proves
 * whichever is chosen.
 */
export function LineCounterpartSelect({
  index,
  options,
  initialValue,
  offerWaiting,
}: {
  index: number;
  options: readonly CounterpartOption[];
  initialValue: string;
  /** Card payments may wait for a match; a bank-statement transfer picks a company as before. */
  offerWaiting: boolean;
}) {
  const { actions } = useReviewState();
  const active = (actions[String(index)] ?? 'post') === 'intercompany_transfer';
  const [value, setValue] = useState(initialValue);
  // The page re-reads the server while a line waits (LL-106): when the refresh brings a match
  // for a row still on "waiting", adopt it — a manual pick is never overridden (state adjusted
  // during render, no effect).
  const [seenInitial, setSeenInitial] = useState(initialValue);
  if (seenInitial !== initialValue) {
    setSeenInitial(initialValue);
    if (value === '' && initialValue !== '') setValue(initialValue);
  }
  return (
    <>
      <select
        name="counterpart"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        data-testid={`import-counterpart-${String(index)}`}
        className={SELECT}
        hidden={!active}
        aria-label="Other company"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
        {offerWaiting && <option value="">Waiting for the other company&apos;s statement…</option>}
      </select>
      {active && value === '' && (
        <span data-testid={`waiting-flag-${String(index)}`} className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
          waiting for a match
        </span>
      )}
    </>
  );
}
