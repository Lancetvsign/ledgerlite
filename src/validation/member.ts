import { z } from 'zod';

import { ROLES } from '@/server/rbac';

/**
 * Team membership inputs — LL-086. The email is trimmed and lower-cased at the
 * boundary: Better Auth stores emails lower-cased, and the invitations table has a
 * CHECK that the stored value is already normalised.
 */
export const memberRoleInput = z.enum(ROLES);

export const inviteMemberInput = z.object({
  email: z.string().trim().toLowerCase().max(320, 'Email is unreasonably long.').pipe(z.email('Enter a valid email address.')),
  role: memberRoleInput,
});
export type InviteMemberInput = z.infer<typeof inviteMemberInput>;

export const changeMemberRoleInput = z.object({
  membershipId: z.uuid(),
  role: memberRoleInput,
});
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleInput>;
