'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { LedgerError, postJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { postJournalEntryInput } from '@/validation/journal';

/**
 * Manual journal-entry posting action — LL-035.
 *
 * Everything the browser sends is untrusted. The company comes from the
 * server-authorized session context (never a form field), and `postJournalEntry`
 * re-authorizes (`journal.post`) and re-validates balance, accounts, and period
 * regardless of what the client computed or disabled. A client that strips the
 * disabled attribute off Submit and posts garbage lands here and is refused.
 */

async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  return { userId: user.id, companyId: membership.companyId };
}

/** '' → '0'; anything else passes through untouched for Zod to judge. */
function amount(v: FormDataEntryValue | undefined): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? '0' : s;
}

function isZeroish(s: string): boolean {
  return s === '' || /^-?0*(\.0*)?$/.test(s.trim());
}

export async function postJournalEntryAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();

  // Zip the parallel per-line arrays. A line the user never filled in (no account
  // and no amounts) is dropped; a line with an account but a bad amount is KEPT so
  // the server rejects it with a real message rather than silently swallowing it.
  const accountIds = formData.getAll('accountId');
  const debits = formData.getAll('debit');
  const credits = formData.getAll('credit');
  const descriptions = formData.getAll('lineDescription');

  const lines = accountIds
    .map((accountId, i) => {
      const desc = descriptions[i];
      return {
        accountId: typeof accountId === 'string' ? accountId : '',
        description: typeof desc === 'string' ? desc.trim() : '',
        debit: amount(debits[i]),
        credit: amount(credits[i]),
      };
    })
    .filter((l) => !(l.accountId === '' && isZeroish(l.debit) && isZeroish(l.credit)))
    .map((l) => ({
      accountId: l.accountId,
      description: l.description === '' ? undefined : l.description,
      debit: l.debit,
      credit: l.credit,
    }));

  const parsed = postJournalEntryInput.safeParse({
    companyId,
    actorUserId: userId,
    transactionDate: formData.get('transactionDate'),
    postingDate: emptyToUndefined(formData.get('postingDate')),
    description: emptyToUndefined(formData.get('description')),
    sourceType: 'JOURNAL_ENTRY',
    lines,
  });
  if (!parsed.success) redirect('/journal/new?error=invalid');

  let entryId: string;
  try {
    const posted = await postJournalEntry(parsed.data);
    entryId = posted.entry.id;
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect('/journal/new?error=denied');
    if (error instanceof LedgerError) redirect(`/journal/new?error=${error.code}`);
    throw error;
  }
  // Success path: land on the immutable detail view.
  redirect(`/journal/${entryId}`);
}

function emptyToUndefined(v: FormDataEntryValue | null): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
}
