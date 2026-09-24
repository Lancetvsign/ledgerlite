'use client';

import { toLineAction, useReviewState } from './review-state';

const SELECT = 'max-w-56 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

/**
 * One line's Action select plus a one-click Ignore / Undo toggle (LL-089). The select is
 * the value the form submits; the button just sets it. "Undo" returns to the server's
 * suggestion for the line.
 */
export function LineActionControls({
  index,
  moneyIn,
  allowApply,
  matchLabel,
  allowPersonal = false,
  allowIntercompany = false,
  intercompanyMatchLabel,
}: {
  index: number;
  moneyIn: boolean;
  /** False on credit-card statements: lines post to accounts only (LL-088). */
  allowApply: boolean;
  /** Present when a POSTED mirror exists on another statement account (LL-094). */
  matchLabel?: string;
  /** LL-097: offer "Mark personal" (an owner equity/asset account exists to post it to). */
  allowPersonal?: boolean;
  /** LL-099: the company is in an organization with members the reviewer may post in. */
  allowIntercompany?: boolean;
  /** LL-099: the other company already posted its side — offer to match it. */
  intercompanyMatchLabel?: string;
}) {
  const { actions, defaults, setAction } = useReviewState();
  const key = String(index);
  const action = actions[key] ?? 'post';
  const suggested = defaults[key] ?? 'post';
  const ignored = action === 'ignore';

  return (
    <div className="flex items-center gap-1">
      <select
        name="action"
        value={action}
        onChange={(e) => {
          setAction(key, toLineAction(e.target.value));
        }}
        data-testid={`import-action-${String(index)}`}
        className={SELECT}
      >
        <option value="post">Post to account</option>
        <option value="ignore">Ignore</option>
        {allowPersonal && <option value="personal">Mark personal</option>}
        {intercompanyMatchLabel !== undefined && <option value="match_intercompany">{intercompanyMatchLabel}</option>}
        {allowIntercompany && <option value="intercompany_transfer">Transfer with another company…</option>}
        {matchLabel !== undefined && <option value="match_transfer">{matchLabel}</option>}
        {allowApply &&
          (moneyIn ? (
            <option value="apply_invoice">Apply to invoice</option>
          ) : (
            <option value="apply_bill">Apply to bill</option>
          ))}
      </select>
      <button
        type="button"
        data-testid={`ignore-line-${String(index)}`}
        aria-pressed={ignored}
        onClick={() => {
          setAction(key, ignored ? (suggested === 'ignore' ? 'post' : suggested) : 'ignore');
        }}
        className={
          ignored
            ? 'rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700'
            : 'rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300'
        }
      >
        {ignored ? 'Undo' : 'Ignore'}
      </button>
    </div>
  );
}
