import { z } from 'zod';

/**
 * Company creation input. Validated at the boundary; services accept the PARSED
 * type only (docs/API.md).
 *
 * Note what is absent: `ein`. The protected column is not writable through
 * general company creation — a dedicated, justified path can add it later.
 * And no money fields exist here yet, but the rule stands for when they do:
 * money is a string, and a JavaScript number is rejected, never coerced.
 */

/**
 * A timezone is valid if the runtime can actually resolve it — which is the only
 * property that matters, since it is what every date computation depends on.
 *
 * NOT Intl.supportedValuesOf('timeZone'): that curated list omits 'UTC' and the
 * 'Etc/*' zones, which are legitimate IANA identifiers a user may reasonably
 * choose. Trying to construct a DateTimeFormat is the honest test — it accepts
 * exactly what the platform will accept later.
 */
function isResolvableTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const createCompanyInput = z.object({
  legalName: z
    .string()
    .trim()
    .min(1, 'Legal name is required.')
    .max(300, 'Legal name is unreasonably long.'),
  dbaName: z.string().trim().max(300).optional(),
  email: z.email().optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  fiscalYearStartMonth: z
    .int('Fiscal year start month must be a whole number.')
    .min(1, 'Fiscal year start month must be between 1 and 12.')
    .max(12, 'Fiscal year start month must be between 1 and 12.')
    .default(1),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Currency must be a three-letter uppercase ISO 4217 code.')
    .default('USD'),
  timezone: z.string().refine(isResolvableTimezone, {
    message: 'Timezone must be a valid IANA identifier, e.g. America/Chicago.',
  }),
});

export type CreateCompanyInput = z.infer<typeof createCompanyInput>;
