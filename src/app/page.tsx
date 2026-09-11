import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';

/**
 * Root. A signed-in user goes straight to their company (`/account`); everyone else sees
 * the public landing with the way in. Replaces the LL-000 placeholder now that the app is
 * live — a bare "LedgerLite" page at the production URL read as broken.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session !== null) redirect('/account');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">LedgerLite</h1>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">Double-entry accounting for small businesses.</p>
      <Link
        href="/sign-in"
        data-testid="landing-sign-in"
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
      >
        Sign in
      </Link>
    </main>
  );
}
