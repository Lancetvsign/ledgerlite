'use client';

import { useRouter } from 'next/navigation';

import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        void authClient.signOut().then(() => {
          router.push('/');
          router.refresh();
        });
      }}
      className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
    >
      Sign out
    </button>
  );
}
