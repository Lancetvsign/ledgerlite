'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useOptionalReviewVersion } from './review-state';

export type AutosaveResult = { readonly ok: true; readonly saved: number } | { readonly ok: false };

const DEBOUNCE_MS = 600;
const RETRY_MS = 3000;
const REFRESH_MS = 30_000;

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error' };

/**
 * Saves the enclosing form's current per-line choices as drafts — LL-105 / ADR-045.
 *
 * Rendered INSIDE the review (or shared) form. Every DOM change on the form, and every
 * programmatic change the review state reports through its version counter, requests a
 * save; the save runs 600 ms after the last request (each new request restarts the timer),
 * serialising the form exactly as a submit would and handing it to `action` — a server action
 * that upserts drafts and never posts. A failure is reported and retried once after 3 s.
 * Nothing here blocks the real submit. "Save progress" requests a save at once for people
 * who want to click.
 */
export function Autosave({
  action,
  label = 'Save progress',
  waiting = 0,
}: {
  action: (formData: FormData) => Promise<AutosaveResult>;
  label?: string;
  /** LL-106: lines waiting for another company's statement — while any wait, the page re-reads the server every 30 s. */
  waiting?: number;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const router = useRouter();
  const [requested, setRequested] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const version = useOptionalReviewVersion();

  // DOM changes on the form (selects, checkboxes).
  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (form === null || form === undefined) return;
    const onChange = () => {
      setRequested((n) => n + 1);
    };
    form.addEventListener('change', onChange);
    return () => {
      form.removeEventListener('change', onChange);
    };
  }, []);

  // Programmatic changes (Ignore / Undo buttons, Ignore all, Reset) fire no DOM event.
  const seenVersion = useRef(version);
  useEffect(() => {
    if (version !== seenVersion.current) {
      seenVersion.current = version;
      setRequested((n) => n + 1);
    }
  }, [version]);

  // LL-106: while a line waits for the other company's statement, look again every 30 s —
  // the candidates are recomputed by the server on every render, so the match appears here
  // the moment the other statement is uploaded, without leaving the page.
  useEffect(() => {
    if (waiting === 0) return;
    const timer = setInterval(() => {
      router.refresh();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [waiting, router]);

  // The debounced save: a new request during the wait restarts it (the cleanup clears the timer).
  useEffect(() => {
    if (requested === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const form = anchor.current?.closest('form');
      if (form === null || form === undefined) return;
      setStatus({ kind: 'saving' });
      void action(new FormData(form))
        .then((result) => (result.ok ? result : { ok: false as const }))
        .catch(() => ({ ok: false as const }))
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setStatus({ kind: 'saved', at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
          } else {
            setStatus({ kind: 'error' });
            setTimeout(() => {
              if (!cancelled) setRequested((n) => n + 1);
            }, RETRY_MS);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requested, action]);

  return (
    <span ref={anchor} className="flex items-center gap-2 text-xs text-neutral-500" data-testid="autosave">
      <button
        type="button"
        onClick={() => {
          setRequested((n) => n + 1);
        }}
        data-testid="save-progress"
        className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
      >
        {label}
      </button>
      <span data-testid="autosave-status" data-state={status.kind} aria-live="polite">
        {status.kind === 'saving' ? 'Saving…' : status.kind === 'saved' ? `Saved ${status.at}` : status.kind === 'error' ? 'Not saved — retrying' : ''}
      </span>
      {waiting > 0 && (
        <>
          <span data-testid="waiting-count" className="text-amber-700 dark:text-amber-300">
            {String(waiting)} waiting for another company&apos;s statement · checking every 30 s
          </span>
          <button
            type="button"
            onClick={() => {
              router.refresh();
            }}
            data-testid="check-again"
            className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            Check again
          </button>
        </>
      )}
    </span>
  );
}
