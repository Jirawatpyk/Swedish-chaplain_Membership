import { describe, it, expect, vi } from 'vitest';
import { loadMembersPortalStatus } from '@/modules/members/application/use-cases/load-members-portal-status';
import { ok } from '@/lib/result';

const NOW = new Date('2026-07-23T10:00:00.000Z');
const ctx = { slug: 'swecham' } as never;
const M1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const M2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const U1 = 'cccccccc-3333-4333-8333-333333333333';

function repoWith(rows: Array<{ memberId: string; expiresAt: Date }>) {
  return {
    findPendingInvitationsForPrimaryContacts: vi.fn().mockResolvedValue(ok(rows)),
  } as never;
}

describe('loadMembersPortalStatus', () => {
  it('returns an empty map and makes NO repo call for an empty list', async () => {
    const memberRepo = repoWith([]);
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo },
      { members: [], now: NOW },
    );
    expect(res.ok && res.value.size).toBe(0);
    expect(
      (memberRepo as unknown as { findPendingInvitationsForPrimaryContacts: ReturnType<typeof vi.fn> })
        .findPendingInvitationsForPrimaryContacts,
    ).not.toHaveBeenCalled();
  });

  it('makes NO repo call when every member is unlinked, and maps them all to not_invited', async () => {
    const memberRepo = repoWith([]);
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo },
      { members: [{ memberId: M1, linkedUserId: null }], now: NOW },
    );
    expect(res.ok && res.value.get(M1)).toBe('not_invited');
    expect(
      (memberRepo as unknown as { findPendingInvitationsForPrimaryContacts: ReturnType<typeof vi.fn> })
        .findPendingInvitationsForPrimaryContacts,
    ).not.toHaveBeenCalled();
  });

  it('maps a linked member with no pending invitation to active', async () => {
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo: repoWith([]) },
      { members: [{ memberId: M1, linkedUserId: U1 }], now: NOW },
    );
    expect(res.ok && res.value.get(M1)).toBe('active');
  });

  it('maps live and expired invitations to invited / invite_expired', async () => {
    const res = await loadMembersPortalStatus(
      { tenant: ctx, memberRepo: repoWith([
        { memberId: M1, expiresAt: new Date('2026-07-30T00:00:00.000Z') },
        { memberId: M2, expiresAt: new Date('2026-07-01T00:00:00.000Z') },
      ]) },
      {
        members: [
          { memberId: M1, linkedUserId: U1 },
          { memberId: M2, linkedUserId: U1 },
        ],
        now: NOW,
      },
    );
    expect(res.ok && res.value.get(M1)).toBe('invited');
    expect(res.ok && res.value.get(M2)).toBe('invite_expired');
  });

  it('only queries for members that actually have a linked user', async () => {
    const memberRepo = repoWith([]);
    await loadMembersPortalStatus(
      { tenant: ctx, memberRepo },
      {
        members: [
          { memberId: M1, linkedUserId: U1 },
          { memberId: M2, linkedUserId: null },
        ],
        now: NOW,
      },
    );
    const spy = (memberRepo as unknown as {
      findPendingInvitationsForPrimaryContacts: ReturnType<typeof vi.fn>;
    }).findPendingInvitationsForPrimaryContacts;
    expect(spy).toHaveBeenCalledWith(ctx, [M1]);
  });
});
