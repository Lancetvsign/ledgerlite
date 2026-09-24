import Link from 'next/link';
import { headers } from 'next/headers';

import { getAuth } from '@/lib/auth';
import { describeInvitation } from '@/server/members';

import { claimInvitationAction } from '../../members/actions';
import { JoinForm } from './join-form';

/**
 * Join a company from an invitation link — LL-090. The secret in the URL is the
 * credential: an invalid or expired one reads as not found. Signed out: create the
 * account here (the join cookie set by the form lets the sign-up endpoint admit it).
 * Signed in: claim with one click.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const described = await describeInvitation(token);
  const session = await getAuth().api.getSession({ headers: await headers() });

  if (described === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
        <h1 className="text-2xl font-semibold">Invitation</h1>
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          This invitation link is not valid or has expired. Ask the company owner for a new one.
        </p>
        <Link href="/sign-in" className="text-sm text-neutral-500 underline">Sign in</Link>
      </main>
    );
  }

  const notice = sp.error === 'INVITATION_INVALID' ? 'This invitation link is not valid or has expired.' : sp.error !== undefined ? 'Joining did not complete.' : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Join {described.companyName}</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="join-summary">
        You have been invited to <strong>{described.companyName}</strong> as <strong>{described.role}</strong>.
      </p>
      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{notice}</p>
      )}
      {session === null ? (
        <JoinForm token={token} email={described.email} />
      ) : (
        <form action={claimInvitationAction} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          <p className="text-sm text-neutral-500">Signed in as {session.user.email}.</p>
          <button type="submit" data-testid="claim-invitation" className="rounded bg-neutral-900 px-4 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900">
            Join {described.companyName}
          </button>
        </form>
      )}
    </main>
  );
}
