/**
 * DV-18 — `loadMembersWithoutCycle` use-case unit coverage.
 *
 * The anti-join SQL + archived/erased exclusion + ordering + totalCount are
 * proven against live Neon in
 * `tests/integration/renewals/load-members-without-cycle.test.ts`. This unit
 * suite pins the thin orchestration shape: Result wrapping, default limit,
 * cursor forwarding, and infra-throw propagation (the page wrapper degrades
 * it best-effort).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  loadMembersWithoutCycle,
  MEMBERS_WITHOUT_CYCLE_DEFAULT_LIMIT,
} from '@/modules/renewals';
import type { MembersWithoutCyclePage } from '@/modules/renewals';

function page(
  overrides: Partial<MembersWithoutCyclePage> = {},
): MembersWithoutCyclePage {
  return {
    items: [
      {
        memberId: 'm-1',
        companyName: 'No Cycle Co',
        registrationDate: '2026-03-20',
      },
    ],
    totalCount: 1,
    nextCursor: null,
    ...overrides,
  };
}

describe('loadMembersWithoutCycle (DV-18)', () => {
  it('wraps the repo page in ok() with items + totalCount + nextCursor', async () => {
    const repo = {
      listMembersWithoutCycle: vi.fn().mockResolvedValue(page()),
    };
    const res = await loadMembersWithoutCycle(
      { cyclesRepo: repo as never },
      { tenantId: 't', limit: 50 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items).toHaveLength(1);
    expect(res.value.items[0]!.companyName).toBe('No Cycle Co');
    expect(res.value.totalCount).toBe(1);
    expect(res.value.nextCursor).toBeNull();
  });

  it('forwards the default limit when none is given (no request body source)', async () => {
    const repo = {
      listMembersWithoutCycle: vi
        .fn()
        .mockResolvedValue(page({ items: [], totalCount: 0 })),
    };
    await loadMembersWithoutCycle(
      { cyclesRepo: repo as never },
      { tenantId: 't' },
    );
    expect(repo.listMembersWithoutCycle).toHaveBeenCalledWith('t', {
      limit: MEMBERS_WITHOUT_CYCLE_DEFAULT_LIMIT,
    });
  });

  it('forwards a provided limit + cursor verbatim', async () => {
    const repo = {
      listMembersWithoutCycle: vi.fn().mockResolvedValue(page()),
    };
    await loadMembersWithoutCycle(
      { cyclesRepo: repo as never },
      { tenantId: 't', limit: 25, cursor: 'opaque-cursor' },
    );
    expect(repo.listMembersWithoutCycle).toHaveBeenCalledWith('t', {
      limit: 25,
      cursor: 'opaque-cursor',
    });
  });

  it('returns an empty ok() page when the tenant has no renewal gaps', async () => {
    const repo = {
      listMembersWithoutCycle: vi
        .fn()
        .mockResolvedValue(page({ items: [], totalCount: 0 })),
    };
    const res = await loadMembersWithoutCycle(
      { cyclesRepo: repo as never },
      { tenantId: 't', limit: 100 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items).toHaveLength(0);
    expect(res.value.totalCount).toBe(0);
  });

  it('propagates a repo throw (page wrapper degrades it to a load-error card)', async () => {
    const repo = {
      listMembersWithoutCycle: vi
        .fn()
        .mockRejectedValue(new Error('db down')),
    };
    await expect(
      loadMembersWithoutCycle(
        { cyclesRepo: repo as never },
        { tenantId: 't', limit: 100 },
      ),
    ).rejects.toThrow('db down');
  });
});
