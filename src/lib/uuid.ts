import { z } from 'zod';

/**
 * A page/action-boundary guard: is `s` a well-formed UUID?
 *
 * A route param or query value that is not a UUID (e.g. `/bills/abc`, `?vendorId=xyz`)
 * would otherwise reach `eq(uuidColumn, s)` and surface a raw Postgres 22P02 as a 500,
 * instead of the not-found response a missing-or-foreign id already gets. Call sites
 * treat a `false` here as not-found — the SAME response a nonexistent id produces — so
 * this never becomes a tenant oracle (a well-formed foreign id and a missing id are
 * already indistinguishable). Gate 5 hardening. `z.uuid()` is the validator; this wraps
 * `safeParse` for the many boundaries that need it.
 */
const uuidSchema = z.uuid();

export function isUuid(s: string): boolean {
  return uuidSchema.safeParse(s).success;
}
