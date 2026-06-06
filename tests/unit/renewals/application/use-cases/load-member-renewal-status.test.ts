/**
 * Pass A · Section 1 — `loadMemberRenewalStatus` unit spec.
 *
 * Admin-facing narrow read for the member-detail "Renewal & Health" card.
 * Wraps `cyclesRepo.list({ memberIdFilter, pageSize: 1, sort:
 * 'created_at_desc' })` to surface the member's MOST-RECENT cycle of ANY
 * status (active / awaiting_payment / lapsed / completed / cancelled) so
 * the admin sees the current renewal posture without leaving for
 * `/admin/renewals`.
 *
 * Reads only — never mutates. Returns `{ cycle: null }` when the member
 * has no cycle yet (empty-state on the card). A repo throw degrades to
 * `server_error` (the card renders an em-dash, never crashes the page).
 */
import { describe, expect, it, vi } from 'vitest';
import { loadMemberRenewalStatus } from '@/modules/renewals/application/use-cases/load-member-renewal-status';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { buildCycle } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a121';

function fakeDeps(args: {
  items?: ReadonlyArray<RenewalCycle>;
  listImpl?: 'throw';
}): {
  deps: RenewalsDeps;
  listMock: ReturnType<typeof vi.fn>;
} {
  const listMock = vi.fn(async () => {
    if (args.listImpl === 'throw') {
      throw new Error('cyclesRepo.list: simulated failure');
    }
    return { items: args.items ?? [], nextCursor: null };
  });
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: { list: listMock },
  } as unknown as RenewalsDeps;
  return { deps, listMock };
}

describe('loadMemberRenewalStatus (Pass A · Section 1)', () => {
  it('returns the most-recent cycle for the member', async () => {
    const cycle = buildCycle({
      memberId: MEMBER_UUID,
      status: 'awaiting_payment',
    });
    const { deps, listMock } = fakeDeps({ items: [cycle] });

    const res = await loadMemberRenewalStatus(deps, {
      tenantId: TENANT_ID,
      memberId: MEMBER_UUID,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.cycle?.cycleId).toBe(cycle.cycleId);
    expect(res.value.cycle?.status).toBe('awaiting_payment');
    // Verify the query shape the review cited: single most-recent row.
    expect(listMock).toHaveBeenCalledWith(TENANT_ID, {
      memberIdFilter: MEMBER_UUID,
      pageSize: 1,
      sort: 'created_at_desc',
    });
  });

  it('returns cycle=null when the member has no renewal cycle', async () => {
    const { deps } = fakeDeps({ items: [] });

    const res = await loadMemberRenewalStatus(deps, {
      tenantId: TENANT_ID,
      memberId: MEMBER_UUID,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.cycle).toBeNull();
  });

  it('surfaces a lapsed cycle (terminal status still shown)', async () => {
    const lapsed = buildCycle({
      memberId: MEMBER_UUID,
      status: 'lapsed',
      closedAt: '2026-05-20T00:00:00Z',
      closedReason: 'grace_expired',
    });
    const { deps } = fakeDeps({ items: [lapsed] });

    const res = await loadMemberRenewalStatus(deps, {
      tenantId: TENANT_ID,
      memberId: MEMBER_UUID,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.cycle?.status).toBe('lapsed');
  });

  it('degrades to server_error when the repo throws (page never crashes)', async () => {
    const { deps } = fakeDeps({ listImpl: 'throw' });

    const res = await loadMemberRenewalStatus(deps, {
      tenantId: TENANT_ID,
      memberId: MEMBER_UUID,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected err');
    expect(res.error.kind).toBe('server_error');
  });
});
