'use client';

import { useReviewState } from './review-state';

/**
 * Bulk decisions for the review screen (LL-089): ignore every remaining line (then undo
 * the few that belong here), or reset every line to the server's suggestion; with a live
 * count of what the submit will do. Nothing persists until "Post confirmed lines".
 */
export function BulkControls() {
  const { actions, ignoreAll, resetAll } = useReviewState();
  const values = Object.values(actions);
  const ignore = values.filter((a) => a === 'ignore').length;
  const personal = values.filter((a) => a === 'personal').length;
  const post = values.length - ignore - personal;
  if (values.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="bulk-controls">
      <span className="text-neutral-600 dark:text-neutral-400" data-testid="review-counts" aria-live="polite">
        {String(post)} to post · {String(ignore)} to ignore{personal > 0 ? ` · ${String(personal)} personal` : ''}
      </span>
      <button type="button" onClick={ignoreAll} data-testid="ignore-all" className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
        Ignore all remaining
      </button>
      <button type="button" onClick={resetAll} data-testid="reset-all" className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
        Reset to suggestions
      </button>
      <span className="basis-full text-xs text-neutral-400">
        Your own purchases: “Mark personal” (they post to your owner-distributions account, so the card still
        reconciles). Charges that belong to another of your companies: leave them staged and share the statement —
        that company takes them from its own Bank Import → “Shared with you”.
      </span>
    </div>
  );
}
