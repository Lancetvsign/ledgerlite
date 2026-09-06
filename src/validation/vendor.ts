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
 * Vendor creation input — LL-060 (the mirror of the customer input). Company is NOT
 * a field: it comes from the server-authorized session context, never the caller
 * (AGENTS §6). Status is not a field either — a vendor is created ACTIVE and
 * deactivated through its own path (ADR-006), never set arbitrarily here.
 */
export const createVendorInput = z.object({
  name: z.string().trim().min(1, 'Vendor name is required.').max(200),
  vendorNumber: optionalTrimmed(40),
  email: optionalEmail,
  phone: optionalTrimmed(40),
  address: optionalTrimmed(1000),
  notes: optionalTrimmed(2000),
});
export type CreateVendorInput = z.infer<typeof createVendorInput>;

/** What may be edited on an existing vendor. Not company, not status. */
export const updateVendorInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  vendorNumber: optionalTrimmed(40),
  email: optionalEmail,
  phone: optionalTrimmed(40),
  address: optionalTrimmed(1000),
  notes: optionalTrimmed(2000),
});
export type UpdateVendorInput = z.infer<typeof updateVendorInput>;
