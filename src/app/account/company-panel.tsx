import { createCompanyAction, switchCompanyAction } from './actions';

import type { CompanyMembership } from '@/db/schema';
import type { CompanyView } from '@/server/companies';

/**
 * Minimal company switcher (LL-013). Lists ONLY companies where this user
 * holds an active membership — the list arrives from the server already
 * scoped, and picking one round-trips through a server action that re-proves
 * membership before the cookie moves.
 */
export function CompanyPanel({
  companies,
  active,
}: {
  companies: { company: CompanyView; role: CompanyMembership['role'] }[];
  active: CompanyMembership | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Companies</h2>

      {companies.length === 0 ? (
        <p className="text-sm text-neutral-500">No companies yet — create one below.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="company-list">
          {companies.map(({ company, role }) => {
            const isActive = active?.companyId === company.id;
            return (
              <li key={company.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <span data-testid="company-name">{company.legalName}</span>{' '}
                  <span className="text-neutral-500">· {role}</span>
                  {isActive && (
                    <span data-testid="active-badge" className="ml-2 rounded bg-neutral-200 px-2 py-0.5 text-xs dark:bg-neutral-800">
                      active
                    </span>
                  )}
                </span>
                {!isActive && (
                  <form action={switchCompanyAction}>
                    <input type="hidden" name="companyId" value={company.id} />
                    <button type="submit" className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
                      Switch
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form action={createCompanyAction} className="flex gap-2">
        <input
          name="legalName"
          placeholder="New company legal name"
          required
          className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button type="submit" className="rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          Create
        </button>
      </form>
    </section>
  );
}
