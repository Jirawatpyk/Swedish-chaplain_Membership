/**
 * Unit tests for `getMembersHaltedInTenant` use case (T029, F7 Batch C).
 * Pure pass-through to `memberRepo.findMembersHaltedForBroadcast`.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { getMembersHaltedInTenant } from '@/modules/members/application/use-cases/get-members-halted-in-tenant';
import type { F7MemberHaltSummary } from '@/modules/members/application/ports/member-repo';

const tenant = asTenantContext('test-tenant');

describe('getMembersHaltedInTenant', () => {
  it('returns the halted-members summary list from repo', async () => {
    const summaries: F7MemberHaltSummary[] = [
      {
        memberId: 'm1',
        displayName: 'Acme Corp',
        haltedSinceAt: new Date('2026-04-29T10:00:00Z'),
      },
    ];
    const memberRepo = {
      findMembersHaltedForBroadcast: vi.fn().mockResolvedValue(ok(summaries)),
    } as unknown as Parameters<typeof getMembersHaltedInTenant>[0]['memberRepo'];

    const result = await getMembersHaltedInTenant({ tenant, memberRepo });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(summaries);
    expect(memberRepo.findMembersHaltedForBroadcast).toHaveBeenCalledWith(
      tenant,
    );
  });

  it('returns empty array when no members halted', async () => {
    const memberRepo = {
      findMembersHaltedForBroadcast: vi.fn().mockResolvedValue(ok([])),
    } as unknown as Parameters<typeof getMembersHaltedInTenant>[0]['memberRepo'];

    const result = await getMembersHaltedInTenant({ tenant, memberRepo });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('propagates repo error', async () => {
    const memberRepo = {
      findMembersHaltedForBroadcast: vi
        .fn()
        .mockResolvedValue(err({ code: 'repo.unexpected', cause: 'boom' })),
    } as unknown as Parameters<typeof getMembersHaltedInTenant>[0]['memberRepo'];

    const result = await getMembersHaltedInTenant({ tenant, memberRepo });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });
});
