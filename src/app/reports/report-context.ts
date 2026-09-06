import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { isCalendarDate, todayInTimeZone } from '@/lib/dates';
import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCompaniesForUser } from '@/server/companies';
import { ensureAppUser } from '@/server/users';

import type { CompanyMembership } from '@/db/schema';

/**
 * Shared authorization + context for the read-only report screens (LL-055).
 *
 * Mirrors the /accounts + /invoices pages: authenticate, resolve the app user,
 * and take the company from the SERVER-authorized session context — never a URL
 * or query param, so there is no company id to manipulate in the address bar.
 * `report.view` itself is enforced by each service on every call (AGENTS §6);
 * this only establishes who and which company.
 *
 * Also resolves the company's timezone so "as of" defaults to the company's
 * today (ADR-007) rather than the server's.
 */
export interface ReportContext {
  readonly userId: string;
  readonly companyId: string;
  readonly role: CompanyMembership['role'];
  readonly timezone: string;
  /** The company's today (YYYY-MM-DD) — the default "as of"/period-end date. */
  readonly today: string;
}

export async function requireReportContext(): Promise<ReportContext> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account'); // pick a company first

  // Timezone comes from the active company (an authorized service read), so the
  // default date is the company's today, consistent with posting (ADR-007).
  const companies = await listCompaniesForUser(user.id);
  const active = companies.find((c) => c.company.id === membership.companyId);
  const timezone = active?.company.timezone ?? 'UTC';

  return {
    userId: user.id,
    companyId: membership.companyId,
    role: membership.role,
    timezone,
    today: todayInTimeZone(timezone),
  };
}

/**
 * Resolve an "as of" query param for the Trial Balance and Aging screens: an
 * absent or empty value defaults to the company's today; an explicitly-supplied
 * value that is not a calendar date is flagged `invalid` (the page shows a notice
 * and no results) rather than silently accepted.
 */
export function resolveAsOf(raw: string | undefined, today: string): { asOf: string; invalid: boolean } {
  const invalid = raw !== undefined && raw !== '' && !isCalendarDate(raw);
  const asOf = raw !== undefined && isCalendarDate(raw) ? raw : today;
  return { asOf, invalid };
}
