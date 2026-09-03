import { z } from 'zod';

/** Optional, trimmed, and empty-string → undefined (never store a blank). */
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

/** Optional email, validated only when present. */
const optionalEmail = z
  .string()
  .trim()
  .max(320)
  .email('Enter a valid email address.')
  .optional()
  .or(z.literal('').transform(() => undefined));

/**
 * Customer creation input — LL-040. Company is NOT a field: it comes from the
 * server-authorized session context, never the caller (AGENTS §6). Status is not
 * a field either — a customer is created ACTIVE and deactivated through its own
 * path (ADR-006), never set arbitrarily here.
 */
export const createCustomerInput = z.object({
  name: z.string().trim().min(1, 'Customer name is required.').max(200),
  customerNumber: optionalTrimmed(40),
  email: optionalEmail,
  phone: optionalTrimmed(40),
  billingAddress: optionalTrimmed(1000),
  notes: optionalTrimmed(2000),
});
export type CreateCustomerInput = z.infer<typeof createCustomerInput>;

/** What may be edited on an existing customer. Not company, not status. */
export const updateCustomerInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  customerNumber: optionalTrimmed(40),
  email: optionalEmail,
  phone: optionalTrimmed(40),
  billingAddress: optionalTrimmed(1000),
  notes: optionalTrimmed(2000),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerInput>;
