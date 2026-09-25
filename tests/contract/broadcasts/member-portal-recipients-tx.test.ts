/**
 * F119 T166 follow-up — `memberPortalRecipients` (the composition root's
 * `MemberPortalRecipientPort`) keeps BOTH of its reads on the caller's tx.
 *
 * `sendVersionToMember`, `confirmSchedule` and the day-30 expiry call it inside
 * a transaction that holds the broadcast row's `FOR UPDATE` lock. The contact
 * read already used that tx; the linked-login read (`listActiveUserIdsWithRole`,
 * cross-tenant `users`) went to the pool-global `db` and took a second pool
 * connection while the first sat locked — the R-L3 pool-starvation class.
 */
import { describe, expect, it, vi } from 'vitest';

const activeIds = vi.hoisted(() => vi.fn(async (_ids: readonly string[], _role: string, _tx?: unknown) => new Set(['u-1'])));
vi.mock('@/modules/auth/infrastructure/db/active-users-by-role-repo', () => ({
  listActiveUsersByRole: vi.fn(async () => []),
  listActiveUserIdsWithRole: activeIds,
}));

import { memberPortalRecipients } from '@/lib/broadcast-approval-deps';
import { ApprovalDependencyError, approvalErrKind } from '@/modules/broadcasts';
import { drizzleContactRepo } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';

const TX = { sentinel: 'locked-tenant-tx' };

describe('memberPortalRecipients.listActivePortalContacts — one connection', () => {
  it('reads the contacts AND the linked logins on the tx it is handed', async () => {
    const contacts = vi.spyOn(drizzleContactRepo, 'listByMemberInTx').mockResolvedValue({
      ok: true,
      value: [
        {
          contactId: 'c-1',
          email: 'owner@acme.test',
          preferredLanguage: 'th',
          linkedUserId: 'u-1',
          isPrimary: true,
          removedAt: null,
        },
      ],
    } as never);

    const listed = await memberPortalRecipients.listActivePortalContacts(asTenantContext('test-tenant'), 'm-1', TX);

    expect(contacts.mock.calls[0]![0]).toBe(TX);
    expect(activeIds).toHaveBeenCalledWith(['u-1'], 'member', TX);
    expect(listed.map((c) => c.contactId)).toEqual(['c-1']);
  });

  // F119 round-4 B3 — a failed contact read used to throw a plain `Error`, so
  // every caller logged `err: 'Error'`. It now names the read and the repo code.
  it('a failed contact read throws ApprovalDependencyError(portal_contacts, <repo code>) — approvalErrKind keeps the cause', async () => {
    vi.spyOn(drizzleContactRepo, 'listByMemberInTx').mockResolvedValue({
      ok: false,
      error: { code: 'repo.unexpected' },
    } as never);

    const thrown = await memberPortalRecipients.listActivePortalContacts(asTenantContext('test-tenant'), 'm-1', TX).then(
      () => null,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(ApprovalDependencyError);
    expect(approvalErrKind(thrown)).toBe('ApprovalDependencyError:portal_contacts:repo.unexpected');
  });
});
