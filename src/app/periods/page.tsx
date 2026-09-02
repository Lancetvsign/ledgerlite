import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listPeriods } from '@/server/periods';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { PeriodActions } from './period-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Periods view. Read-only listing; close/reopen offered only to a role holding
 * period.close, and the SERVER re-checks regardless of what the UI renders.
 */
export default async function PeriodsPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const appUser = await ensureAppUser(session.user);

  const active = await getActiveCompanyMembership(appUser.id);
  if (active === null) {
    return (
      <main className="mx-auto max-w-lg p-8">
        <p className="text-sm text-neutral-500">Select a company on your account page first.</p>
      </main>
    );
  }

  const periods = await listPeriods(appUser.id, active.companyId);
  const canManage = roleHasCapability(active.role, 'period.close');

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Accounting periods</h1>
      {periods.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No periods yet — they are created as activity references them.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="period-table">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="py-1">Period</th>
              <th className="py-1">Status</th>
              {canManage && <th className="py-1">Action</th>}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="py-2 font-mono">{p.startDate} → {p.endDate}</td>
                <td className="py-2">{p.status}</td>
                {canManage && (
                  <td className="py-2">
                    <PeriodActions periodId={p.id} status={p.status} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
