'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Client-side state for the review screen's per-line decisions — LL-089.
 *
 * Nothing here persists: a decision only becomes real when the reviewer submits
 * "Post confirmed lines" (the service records posts and ignores together). This
 * state exists so that one click can ignore a line, one click can ignore every
 * remaining line, and the reviewer sees how many lines will post before submitting.
 * The server-computed suggestion is the default each line resets to.
 */
export type LineAction = 'post' | 'ignore' | 'apply_invoice' | 'apply_bill' | 'match_transfer' | 'personal' | 'intercompany_transfer' | 'match_intercompany';

export function toLineAction(value: string): LineAction {
  return value === 'ignore' || value === 'apply_invoice' || value === 'apply_bill' || value === 'match_transfer' || value === 'personal' || value === 'intercompany_transfer' || value === 'match_intercompany' ? value : 'post';
}

interface ReviewState {
  readonly actions: Readonly<Record<string, LineAction>>;
  readonly defaults: Readonly<Record<string, LineAction>>;
  readonly setAction: (key: string, action: LineAction) => void;
  readonly ignoreAll: () => void;
  readonly resetAll: () => void;
}

const Ctx = createContext<ReviewState | null>(null);

export function ReviewStateProvider({
  defaults,
  children,
}: {
  /** Line index → the server's suggested action, for every STAGED line. */
  defaults: Readonly<Record<string, LineAction>>;
  children: ReactNode;
}) {
  const [actions, setActions] = useState<Readonly<Record<string, LineAction>>>(defaults);
  const value = useMemo<ReviewState>(
    () => ({
      actions,
      defaults,
      setAction: (key, action) => {
        setActions((prev) => ({ ...prev, [key]: action }));
      },
      ignoreAll: () => {
        setActions((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, 'ignore' as const])));
      },
      resetAll: () => {
        setActions(defaults);
      },
    }),
    [actions, defaults],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReviewState(): ReviewState {
  const state = useContext(Ctx);
  if (state === null) throw new Error('useReviewState must be used inside ReviewStateProvider');
  return state;
}
