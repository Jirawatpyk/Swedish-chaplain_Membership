/**
 * Unit tests for `getMembersBySegment` use case (T029, F7 Batch C).
 *
 * Pure pass-through to `memberRepo.findMembersBySegmentForBroadcast`.
 * Tests verify the use-case forwards inputs correctly + returns the
 * repo Result unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { getMembersBySegment } from '@/modules/members/application/use-cases/get-members-by-segment';
import type { F7MemberRecipient } from '@/modules/members/application/ports/member-repo';

const tenant = asTenantContext('test-tenant');

function makeRecipient(memberId: string): F7MemberRecipient {
  return {
    memberId: memberId as F7MemberRecipient['memberId'],
    displayName: `Member ${memberId}`,
    primaryContactEmail: `${memberId}@example.com`,
    tierCode: 'corporate',
    broadcastsHaltedUntilAdminReview: false,
  };
}

describe('getMembersBySegment', () => {
  it('forwards segmentType=all_members to repo + returns repo result', async () => {
    const recipients = [makeRecipient('m1'), makeRecipient('m2')];
    const memberRepo = {
      findMembersBySegmentForBroadcast: vi
        .fn()
        .mockResolvedValue(ok(recipients)),
    } as unknown as Parameters<typeof getMembersBySegment>[0]['memberRepo'];

    const result = await getMembersBySegment(
      { tenant, memberRepo },
      { segmentType: 'all_members' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(recipients);
    expect(memberRepo.findMembersBySegmentForBroadcast).toHaveBeenCalledWith(
      tenant,
      { segmentType: 'all_members' },
    );
  });

  it('forwards segmentType=tier with tierCodes', async () => {
    const memberRepo = {
      findMembersBySegmentForBroadcast: vi.fn().mockResolvedValue(ok([])),
    } as unknown as Parameters<typeof getMembersBySegment>[0]['memberRepo'];

    await getMembersBySegment(
      { tenant, memberRepo },
      { segmentType: 'tier', tierCodes: ['premium', 'large'] },
    );

    expect(memberRepo.findMembersBySegmentForBroadcast).toHaveBeenCalledWith(
      tenant,
      { segmentType: 'tier', tierCodes: ['premium', 'large'] },
    );
  });

  it('propagates repo error', async () => {
    const memberRepo = {
      findMembersBySegmentForBroadcast: vi
        .fn()
        .mockResolvedValue(err({ code: 'repo.unexpected', cause: 'boom' })),
    } as unknown as Parameters<typeof getMembersBySegment>[0]['memberRepo'];

    const result = await getMembersBySegment(
      { tenant, memberRepo },
      { segmentType: 'all_members' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });
});
