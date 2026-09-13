import { roleHasCapability } from '@/server/rbac';

import {
  createCompanyAction,
  deleteCompanyAction,
  setCompanyTemplateAction,
  switchCompanyAction,
  updateCompanySettingsAction,
} from './actions';

import type { CompanyMembership } from '@/db/schema';
import type { CompanyView } from '@/server/companies';

/**
 * Minimal company switcher (LL-013). Lists ONLY companies where this user
 * holds an active membership — the list arrives from the server already
 * scoped, and picking one round-trips through a server action that re-proves
 * membership before the cookie moves.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const SMALL_BUTTON = 'rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700';
const SMALL_INPUT = 'rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900';
const POPOVER = 'absolute right-0 z-10 mt-1 flex w-72 flex-col gap-2 rounded border border-neutral-300 bg-white p-3 shadow dark:border-neutral-700 dark:bg-neutral-900';

export function CompanyPanel({
  companies,
  active,
  templateExists,
}: {
  companies: { company: CompanyView; role: CompanyMembership['role'] }[];
  active: CompanyMembership | null;
  /** Whether a master template company exists anywhere (LL-083) — a boolean, never its identity. */
  templateExists: boolean;
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
                  {company.isTemplate && (
                    <span data-testid="template-badge" className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                      template
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {!isActive && (
                    <form action={switchCompanyAction}>
                      <input type="hidden" name="companyId" value={company.id} />
                      <button type="submit" className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
                        Switch
                      </button>
                    </form>
                  )}
                  {roleHasCapability(role, 'company.template') && (!templateExists || company.isTemplate) && (
                    // Designate when no template exists anywhere; release only the template
                    // itself. The service re-proves OWNER and the index arbitrates (LL-083).
                    <form action={setCompanyTemplateAction}>
                      <input type="hidden" name="companyId" value={company.id} />
                      <input type="hidden" name="on" value={company.isTemplate ? '0' : '1'} />
                      <button
                        type="submit"
                        data-testid={company.isTemplate ? 'release-template' : 'make-template'}
                        className={SMALL_BUTTON}
                      >
                        {company.isTemplate ? 'Stop being the template' : 'Make master template'}
                      </button>
                    </form>
                  )}
                  {company.isTemplate && roleHasCapability(role, 'company.manage') && (
                    <details className="relative">
                      <summary className={`cursor-pointer list-none ${SMALL_BUTTON}`}>Settings…</summary>
                      <form action={updateCompanySettingsAction} className={POPOVER}>
                        <input type="hidden" name="companyId" value={company.id} />
                        <p className="text-xs text-neutral-600 dark:text-neutral-400">
                          New companies created from the template start with these settings.
                        </p>
                        <label className="flex flex-col gap-1 text-xs text-neutral-500">
                          Fiscal year starts in
                          <select name="fiscalYearStartMonth" defaultValue={String(company.fiscalYearStartMonth)} className={SMALL_INPUT}>
                            {MONTHS.map((m, i) => (
                              <option key={m} value={String(i + 1)}>{m}</option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-neutral-500">
                          Currency (ISO 4217)
                          <input name="currencyCode" defaultValue={company.currencyCode} maxLength={3} required className={SMALL_INPUT} />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-neutral-500">
                          Timezone (IANA)
                          <input name="timezone" defaultValue={company.timezone} required className={SMALL_INPUT} />
                        </label>
                        <button type="submit" data-testid="save-settings" className="rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900">
                          Save settings
                        </button>
                      </form>
                    </details>
                  )}
                  {roleHasCapability(role, 'company.delete') && (
                    // Progressive disclosure without client JS: the confirmation form is
                    // hidden until the owner opens it, and the typed name is compared
                    // server-side (LL-082).
                    <details className="relative">
                      <summary className="cursor-pointer list-none rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300">
                        Delete…
                      </summary>
                      <form
                        action={deleteCompanyAction}
                        className="absolute right-0 z-10 mt-1 flex w-72 flex-col gap-2 rounded border border-neutral-300 bg-white p-3 shadow dark:border-neutral-700 dark:bg-neutral-900"
                      >
                        <input type="hidden" name="companyId" value={company.id} />
                        <p className="text-xs text-neutral-600 dark:text-neutral-400">
                          Type the company name to confirm. A company with posted history is archived
                          (hidden, records kept); an untouched company is removed.
                        </p>
                        <input
                          name="confirmLegalName"
                          placeholder="Type the company name to confirm"
                          autoComplete="off"
                          required
                          className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                        />
                        <button
                          type="submit"
                          data-testid="delete-company-confirm"
                          className="rounded bg-red-700 px-2 py-1 text-xs text-white hover:bg-red-800"
                        >
                          Delete company
                        </button>
                      </form>
                    </details>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <form action={createCompanyAction} className="flex flex-col gap-2">
        <input
          name="legalName"
          placeholder="New company legal name"
          required
          className="rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          Chart of accounts
          <select
            name="chart"
            defaultValue={templateExists ? 'template' : 'standard'}
            className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            {templateExists && <option value="template">Master template</option>}
            <option value="standard">Standard small business</option>
            <option value="system-only">Required accounts only</option>
          </select>
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          Create
        </button>
      </form>
    </section>
  );
}
