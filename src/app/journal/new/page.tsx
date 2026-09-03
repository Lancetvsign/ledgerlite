import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { JournalEntryForm } from './journal-entry-form';

/**
 * Manual journal entry — LL-035. ACCOUNTANT/ADMIN/OWNER only.
 *
 * The capability gate here is one of TWO independent checks: this page hides the
 * form from anyone without `journal.create`, and the posting action re-checks
 * `journal.post` on the server (AGENTS §6). Hiding the form is the courtesy;
 * the action is the control.
 *
 * The account options handed to the form are already scoped to this company and
 * exclude inactive accounts — a picker can never surface another tenant's account
 * or a deactivated one, because the list it is built from never contains them.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function NewJournalEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.create')) {
    // Not authorized to create journal entries — no form, no leak of what's here.
    redirect('/account?error=denied');
  }

  const accounts = await listAccounts(user.id, membership.companyId);
  const active = accounts
    .filter((a) => a.status === 'ACTIVE')
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name }));

  const params = await searchParams;
  // A sensible default the user can change; the server validates the period on
  // whatever date is actually submitted, so this is convenience, not control.
  const today = new Date().toISOString().slice(0, 10);

  return <JournalEntryForm accounts={active} defaultDate={today} notice={noticeFrom(params.error)} />;
}

function noticeFrom(error: string | undefined): string | null {
  if (error === undefined) return null;
  if (error === 'invalid') return 'Please check the entry and try again.';
  if (error === 'UNBALANCED_JOURNAL_ENTRY') return 'Debits and credits must be equal.';
  if (error === 'PERIOD_CLOSED') return 'That posting date falls in a closed period.';
  if (error === 'INACTIVE_ACCOUNT') return 'One of the accounts is inactive.';
  if (error === 'ACCOUNT_NOT_FOUND') return 'One of the accounts does not exist.';
  if (error === 'INSUFFICIENT_LINES') return 'An entry needs at least two lines.';
  if (error === 'INVALID_LINE') return 'Each line needs exactly one amount, debit or credit.';
  if (error === 'denied') return 'You do not have permission to post journal entries.';
  return 'That entry could not be posted.';
}
