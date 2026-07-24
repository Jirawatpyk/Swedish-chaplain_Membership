import { describe, it, expect, vi } from 'vitest';
import { countMembersNeedingPortalInvite } from '@/modules/members/application/use-cases/count-members-needing-portal-invite';
import { ok, err } from '@/lib/result';

const NOW = new Date('2026-07-23T10:00:00.000Z');
const ctx = { slug: 'swecham' } as never;

const filter = {
  status: ['active', 'inactive'] as const,
  portalNeedsInvite: { now: NOW },
  limit: 50,
  offset: 0,
} as never;

function repoReturning(value: ReturnType<typeof ok> | ReturnType<typeof err>) {
  return {
    countMembersNeedingPortalInvite: vi.fn().mockResolvedValue(value),
  } as never;
}

describe('countMembersNeedingPortalInvite (use case)', () => {
  it('passes the count through when the repo succeeds', async () => {
    const res = await countMembersNeedingPortalInvite(
      { tenant: ctx, memberRepo: repoReturning(ok(12)) },
      filter,
    );
    expect(res.ok && res.value).toBe(12);
  });

  it('THROWS on a repo failure — never coerces it to 0', async () => {
    // Coercing a repo error to `0` would tell the chip "0 members need
    // inviting" on a DB outage, hiding the chip and reading as "everyone has
    // been invited" — a lie. The page's `…Safe` wrapper catches this throw and
    // degrades to `null` (a disabled "unavailable" chip). This is the exact
    // failure the page-level wiring test cannot catch, because it mocks THIS
    // use case rather than the repo underneath it.
    await expect(
      countMembersNeedingPortalInvite(
        { tenant: ctx, memberRepo: repoReturning(err({ code: 'repo.unexpected' })) },
        filter,
      ),
    ).rejects.toThrow();
  });
});
