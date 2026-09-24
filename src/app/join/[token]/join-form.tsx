'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';

import { prepareJoinAction } from '../../members/actions';

/**
 * Create an account from an invitation link (LL-090): the server sets the join
 * cookie after validating the link, sign-up runs through Better Auth as usual (the
 * gate admits it because of that cookie), then the page reloads signed in and offers
 * the one-click claim.
 */
export function JoinForm({ token, email: invitedEmail }: { token: string; email: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const prepared = await prepareJoinAction(token);
    if (!prepared.ok) {
      setBusy(false);
      setError(prepared.error);
      return;
    }
    const result = await authClient.signUp.email({ email, password, name: name || email });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? 'Could not create the account.');
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={(e) => { void submit(e); }} className="flex flex-col gap-3" data-testid="join-form">
      <p className="text-sm text-neutral-500">Create your account to join.</p>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" value={name} onChange={(e) => { setName(e.target.value); }} className="rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input type="email" name="email" required value={email} onChange={(e) => { setEmail(e.target.value); }} className="rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input type="password" name="password" required minLength={8} value={password} onChange={(e) => { setPassword(e.target.value); }} className="rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900" />
      </label>
      {error !== null && (
        <p role="alert" data-testid="auth-error" className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <button type="submit" disabled={busy} data-testid="join-create-account" className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
        Create account and continue
      </button>
    </form>
  );
}
