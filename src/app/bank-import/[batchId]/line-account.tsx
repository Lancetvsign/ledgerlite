'use client';

import { useState } from 'react';

import { useReviewState } from './review-state';

const SELECT = 'max-w-56 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

/**
 * One line's Account select (LL-097). Follows the action: choosing "Mark personal" moves the
 * select to the owner's personal account, choosing "Post to account" returns it to the
 * suggestion — the reviewer can still pick anything. The select is what the form submits.
 */
export function LineAccountSelect({
  index,
  options,
  suggestedId,
  personalDefaultId,
}: {
  index: number;
  options: readonly { id: string; label: string }[];
  suggestedId: string;
  personalDefaultId: string | null;
}) {
  const { actions } = useReviewState();
  const action = actions[String(index)] ?? 'post';
  // A change of action resets any manual pick (state adjusted during render, no effect).
  const [seenAction, setSeenAction] = useState(action);
  const [override, setOverride] = useState<string | null>(null);
  if (seenAction !== action) {
    setSeenAction(action);
    setOverride(null);
  }
  const value = override ?? (action === 'personal' && personalDefaultId !== null ? personalDefaultId : suggestedId);
  return (
    <select
      name="accountId"
      value={value}
      onChange={(e) => {
        setOverride(e.target.value);
      }}
      data-testid={`import-account-${String(index)}`}
      className={SELECT}
    >
      <option value="">Choose account…</option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>{a.label}</option>
      ))}
    </select>
  );
}
