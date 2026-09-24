'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Client-side state for the review screen's per-line decisions — LL-089, LL-105.
 *
 * A decision only becomes real when the reviewer submits "Post confirmed lines" (the service
 * records posts and ignores together). This state exists so that one click can ignore a
 * line, one click can ignore every remaining line, and the reviewer sees how many lines will
 * post before submitting. Since LL-105 the current choices are also autosaved as DRAFTS
 * (`autosave.tsx`) so leaving the page loses nothing: `initial` is what the page loads with
 * (the saved draft, else the server's suggestion) and `defaults` stays the suggestion — what
 * "Reset to suggestions" returns to. `version` ticks on every programmatic change so the
 * autosaver notices changes that fire no DOM event.
 */
import { type LineAction } from './line-actions';

export { toLineAction } from './line-actions';
export type { LineAction } from './line-actions';

interface ReviewState {
  readonly actions: Readonly<Record<string, LineAction>>;
  readonly defaults: Readonly<Record<string, LineAction>>;
  readonly version: number;
  readonly setAction: (key: string, action: LineAction) => void;
  readonly ignoreAll: () => void;
  readonly resetAll: () => void;
}

const Ctx = createContext<ReviewState | null>(null);

export function ReviewStateProvider({
  defaults,
  initial,
  children,
}: {
  /** Line index → the server's suggested action, for every STAGED line. */
  defaults: Readonly<Record<string, LineAction>>;
  /** Line index → what the page opens with: the saved draft's action, else the suggestion. */
  initial?: Readonly<Record<string, LineAction>>;
  children: ReactNode;
}) {
  const [actions, setActions] = useState<Readonly<Record<string, LineAction>>>(initial ?? defaults);
  const [version, setVersion] = useState(0);
  const value = useMemo<ReviewState>(
    () => ({
      actions,
      defaults,
      version,
      setAction: (key, action) => {
        setActions((prev) => ({ ...prev, [key]: action }));
        setVersion((v) => v + 1);
      },
      ignoreAll: () => {
        setActions((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, 'ignore' as const])));
        setVersion((v) => v + 1);
      },
      resetAll: () => {
        setActions(defaults);
        setVersion((v) => v + 1);
      },
    }),
    [actions, defaults, version],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReviewState(): ReviewState {
  const state = useContext(Ctx);
  if (state === null) throw new Error('useReviewState must be used inside ReviewStateProvider');
  return state;
}

/** The change counter, or 0 outside a provider (the shared screen has no review state). */
export function useOptionalReviewVersion(): number {
  return useContext(Ctx)?.version ?? 0;
}
