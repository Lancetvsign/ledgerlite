import Link from 'next/link';

import { roleCovers, type Role } from '@/server/rbac';

import { changeMemberRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } from './actions';
import { CopyInviteLink } from './copy-invite-link';

import type { InvitationView, MemberView } from '@/server/members';

const SMALL_BUTTON = 'rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700';
const SMALL_INPUT = 'rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900';

/**
 * Team screen body — LL-086. Server component, forms only. Controls are shown only
 * where the actor's role covers the row's role (`roleCovers`); the withholding is
 * cosmetic — the service refuses regardless.
 */
export function MembersView({
  members,
  invitations,
  selfUserId,
  actorRole,
  canManage,
  grantableRoles,
  notice,
}: {
  members: readonly MemberView[];
  invitations: readonly InvitationView[];
  selfUserId: string;
  actorRole: Role;
  canManage: boolean;
  grantableRoles: readonly Role[];
  notice: { tone: 'ok' | 'error'; text: string } | null;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Team</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">
          ← Account
        </Link>
      </header>

      {notice !== null && (
        <p
          role="status"
          data-testid="notice"
          className={
            notice.tone === 'ok'
              ? 'rounded bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300'
              : 'rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300'
          }
        >
          {notice.text}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Members</h2>
        <table className="w-full border-collapse text-sm" data-testid="members-table">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Name</th>
              <th className="py-2 pr-2">Email</th>
              <th className="py-2 pr-2">Role</th>
              {canManage && <th className="py-2 pr-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.userId === selfUserId;
              const covered = canManage && roleCovers(actorRole, m.role);
              return (
                <tr key={m.membershipId} data-testid="member-row" className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-2 pr-2">
                    <span data-testid="member-name">{m.displayName}</span>
                    {isSelf && (
                      <span data-testid="you-badge" className="ml-2 rounded bg-neutral-200 px-2 py-0.5 text-xs dark:bg-neutral-800">
                        you
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-2 font-mono text-xs" data-testid="member-email">{m.email}</td>
                  <td className="py-2 pr-2" data-testid="member-role">{m.role}</td>
                  {canManage && (
                    <td className="py-2 pr-2">
                      {covered && (
                        <div className="flex flex-wrap items-center gap-2">
                          <form action={changeMemberRoleAction} className="flex items-center gap-1">
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <select name="role" defaultValue={m.role} data-testid="member-role-select" aria-label="New role" className={SMALL_INPUT}>
                              {grantableRoles.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                            <button type="submit" data-testid="change-role" className={SMALL_BUTTON}>Change</button>
                          </form>
                          <form action={removeMemberAction}>
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <button type="submit" data-testid="remove-member" className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300">
                              {isSelf ? 'Leave' : 'Remove'}
                            </button>
                          </form>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {canManage && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Pending invitations</h2>
          {invitations.length === 0 ? (
            <p className="text-sm text-neutral-500">No pending invitations.</p>
          ) : (
            <table className="w-full border-collapse text-sm" data-testid="invitations-table">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                  <th className="py-2 pr-2">Email</th>
                  <th className="py-2 pr-2">Role</th>
                  <th className="py-2 pr-2">Invited</th>
                  <th className="py-2 pr-2">Link</th>
                  <th className="py-2 pr-2" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id} data-testid="invitation-row" className="border-b border-neutral-100 dark:border-neutral-800">
                    <td className="py-2 pr-2 font-mono text-xs">{i.email}</td>
                    <td className="py-2 pr-2">{i.role}</td>
                    <td className="py-2 pr-2 text-neutral-500">{i.createdAt.toISOString().slice(0, 10)}</td>
                    <td className="py-2 pr-2">
                      {i.hasLink ? (
                        <CopyInviteLink invitationId={i.id} />
                      ) : (
                        <span className="text-xs text-neutral-500" data-testid="legacy-invitation">Created before links existed — revoke and invite again.</span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <form action={revokeInvitationAction}>
                        <input type="hidden" name="invitationId" value={i.id} />
                        <button type="submit" data-testid="revoke-invitation" className={SMALL_BUTTON}>Revoke</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form action={inviteMemberAction} className="flex flex-wrap items-end gap-2 rounded border border-neutral-200 p-3 dark:border-neutral-800" data-testid="invite-form">
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Email
              <input name="email" type="email" required placeholder="person@example.com" data-testid="invite-email" className={SMALL_INPUT} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Role
              <select name="role" defaultValue="BOOKKEEPER" data-testid="invite-role" className={SMALL_INPUT}>
                {grantableRoles.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <button type="submit" data-testid="invite-submit" className="rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              Add member
            </button>
            <p className="basis-full text-xs text-neutral-500">
              If the email already has a LedgerLite account they get access at once. Otherwise an invitation is
              recorded: click “Get link” on its row and send that link yourself — opening it lets them create
              their account and join. No email is sent.
            </p>
          </form>
        </section>
      )}
    </main>
  );
}
