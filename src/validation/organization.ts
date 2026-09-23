import { z } from 'zod';

/** Creating an organization (LL-096): a display name only. */
export const createOrganizationInput = z.object({
  name: z.string().trim().min(1, 'Organization name is required.').max(200, 'Organization name is unreasonably long.'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationInput>;
