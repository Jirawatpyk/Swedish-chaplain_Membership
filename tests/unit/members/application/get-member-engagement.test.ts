/**
 * B18 — `getMemberEngagement` use-case (FR-007a engagement source for the
 * member-profile page). Pure pass-through of the repo's risk read with error
 * mapping; covers all branches (ok×2, not_found, server_error).
 */
import { describe, it, expect } from 'vitest';
import { getMemberEngagement } from '@/modules/members/application/use-cases/get-member-engagement';
import { asMemberId } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import { ok, err } from '@/lib/result';
import type { MemberRepo } from '@/modules/members/application/ports/member-repo';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-1111-1111-111111111111');

function deps(findRiskById: MemberRepo['findRiskById']) {
  return { tenant, memberRepo: { findRiskById } as unknown as MemberRepo };
}

describe('getMemberEngagement (B18)', () => {
  it('passes through riskScore + riskScoreBand on success', async () => {
    const r = await getMemberEngagement(
      memberId,
      deps(async () => ok({ riskScore: 40, riskScoreBand: 'warning' })),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ riskScore: 40, riskScoreBand: 'warning' });
    }
  });

  it('passes through null score/band for an un-scored member', async () => {
    const r = await getMemberEngagement(
      memberId,
      deps(async () => ok({ riskScore: null, riskScoreBand: null })),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ riskScore: null, riskScoreBand: null });
    }
  });

  it('maps repo.not_found → not_found', async () => {
    const r = await getMemberEngagement(
      memberId,
      deps(async () => err({ code: 'repo.not_found' })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('not_found');
  });

  it('maps any other repo error → server_error', async () => {
    const r = await getMemberEngagement(
      memberId,
      deps(async () => err({ code: 'repo.unexpected', cause: new Error('x') })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('server_error');
  });
});
