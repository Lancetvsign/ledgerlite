'use client';

import { useActionState } from 'react';

import { issueInvitationLinkAction, type IssueLinkState } from './actions';

/**
 * "Get link" for a pending invitation (LL-090): asks the server for a fresh join
 * link and shows it once, with a copy button. Each request replaces the previous
 * link, so an old one stops working — say so.
 */
export function CopyInviteLink({ invitationId }: { invitationId: string }) {
  const [state, action, pending] = useActionState<IssueLinkState, FormData>(issueInvitationLinkAction, {});
  return (
    <div className="flex flex-col gap-1">
      <form action={action}>
        <input type="hidden" name="invitationId" value={invitationId} />
        <button type="submit" disabled={pending} data-testid="get-invite-link" className="rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-60 dark:border-neutral-700">
          {state.url === undefined ? 'Get link' : 'New link'}
        </button>
      </form>
      {state.url !== undefined && (
        <div className="flex flex-col gap-1 text-xs">
          <code data-testid="invite-link" className="break-all rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">{state.url}</code>
          <span className="text-neutral-500">
            Send this to them yourself. Valid until {state.expiresAt}; requesting a new link makes this one stop working.
          </span>
          <button
            type="button"
            className="self-start underline"
            onClick={() => {
              void navigator.clipboard.writeText(state.url ?? '');
            }}
          >
            Copy
          </button>
        </div>
      )}
      {state.error !== undefined && <span className="text-xs text-red-700 dark:text-red-300">{state.error}</span>}
    </div>
  );
}
