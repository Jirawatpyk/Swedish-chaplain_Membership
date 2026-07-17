/**
 * 066 §4.4(1)/§7 — invoicing MembershipAccessPort bridge (unit).
 *
 * Mocks the leaf renewals repo factory so the composition can be tested
 * without live Neon: a lapsed latest cycle → terminated; a null latest
 * cycle → full; a repo throw → err (never throws — the consumer fails
 * open on this).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findLatestCycleForMemberMock = vi.fn();

vi.mock(
  '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo',
  () => ({
    makeDrizzleRenewalCycleRepo: () => ({
      findLatestCycleForMember: findLatestCycleForMemberMock,
    }),
  }),
);

import { membershipAccessBridge } from '@/modules/invoicing/infrastructure/membership-access-bridge';
import type { TenantContext } from '@/modules/tenants';

const tenant = { slug: 'test-tenant' } as TenantContext;

describe('invoicing membershipAccessBridge', () => {
  beforeEach(() => {
    findLatestCycleForMemberMock.mockReset();
  });

  it('lapsed latest cycle → terminated', async () => {
    // deriveMembershipAccess maps a `lapsed` cycle → terminated regardless
    // of expiry.
    findLatestCycleForMemberMock.mockResolvedValue({
      status: 'lapsed',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const r = await membershipAccessBridge.getMembershipAccess(tenant, 'mem-1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.access).toBe('terminated');
  });

  it('no cycle (null) → full / in_good_standing', async () => {
    findLatestCycleForMemberMock.mockResolvedValue(null);
    const r = await membershipAccessBridge.getMembershipAccess(tenant, 'mem-2');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.access).toBe('full');
      expect(r.value.reason).toBe('in_good_standing');
    }
  });

  it('repo throws → err(membership_access.lookup_error), never throws', async () => {
    findLatestCycleForMemberMock.mockRejectedValue(new Error('DB connection lost'));
    const r = await membershipAccessBridge.getMembershipAccess(tenant, 'mem-3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('membership_access.lookup_error');
  });
});
