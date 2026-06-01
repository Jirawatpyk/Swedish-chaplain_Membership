/**
 * Unit — memberEnumerationAdapter (go-live P1-4 / FR-004).
 *
 * Mocks the members PUBLIC BARREL (`directorySearchWithCount`) + the
 * composition root (`buildMembersDeps`) so the test is DB-free. Asserts the
 * adapter (a) paginates past the 100-row clamp, (b) filters status=['active']
 * only, (c) maps DirectoryRow.member → {memberId, planId, planYear}, and
 * (d) fails loud on a directory-search error (no masked partial set).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '@/modules/tenants';

const directorySearchWithCount = vi.fn();

vi.mock('@/modules/members', () => ({
  directorySearchWithCount: (...args: unknown[]) =>
    directorySearchWithCount(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ tenant: { slug: 'test' }, memberRepo: {} }),
}));

import { memberEnumerationAdapter } from '@/modules/insights/infrastructure/sources/member-enumeration-adapter';

const ctx = { slug: 'test-tenant' } as unknown as TenantContext;

function row(memberId: string, planId = 'corporate-gold', planYear = 2026) {
  return { member: { memberId, planId, planYear } };
}

function page(items: ReturnType<typeof row>[], total: number) {
  return { ok: true as const, value: { items, total } };
}

beforeEach(() => {
  directorySearchWithCount.mockReset();
});

describe('memberEnumerationAdapter.listActiveWithPlan', () => {
  it('maps DirectoryRow.member → {memberId, planId, planYear}', async () => {
    directorySearchWithCount.mockResolvedValueOnce(
      page([row('m1', 'plan-a', 2026), row('m2', 'plan-b', 2025)], 2),
    );
    const out = await memberEnumerationAdapter.listActiveWithPlan(ctx);
    expect(out).toEqual([
      { memberId: 'm1', planId: 'plan-a', planYear: 2026 },
      { memberId: 'm2', planId: 'plan-b', planYear: 2025 },
    ]);
  });

  it('filters status=[active] only (inactive/archived excluded — FR-004 AC8)', async () => {
    directorySearchWithCount.mockResolvedValueOnce(page([row('m1')], 1));
    await memberEnumerationAdapter.listActiveWithPlan(ctx);
    const filterArg = directorySearchWithCount.mock.calls[0]?.[1] as {
      status?: readonly string[];
      limit?: number;
      offset?: number;
    };
    expect(filterArg.status).toEqual(['active']);
    expect(filterArg.limit).toBe(100); // clamp gotcha
    expect(filterArg.offset).toBe(0);
  });

  it('paginates past the 100-row clamp (total > pageSize)', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => row(`m${i}`));
    const tail = [row('m100'), row('m101')];
    directorySearchWithCount
      .mockResolvedValueOnce(page(fullPage, 102)) // offset 0 → 100 rows
      .mockResolvedValueOnce(page(tail, 102)); // offset 100 → 2 rows
    const out = await memberEnumerationAdapter.listActiveWithPlan(ctx);
    expect(out).toHaveLength(102);
    expect(directorySearchWithCount).toHaveBeenCalledTimes(2);
    expect(
      (directorySearchWithCount.mock.calls[1]?.[1] as { offset?: number }).offset,
    ).toBe(100);
  });

  it('stops after one page when items < pageSize', async () => {
    directorySearchWithCount.mockResolvedValueOnce(
      page([row('m1'), row('m2')], 2),
    );
    const out = await memberEnumerationAdapter.listActiveWithPlan(ctx);
    expect(out).toHaveLength(2);
    expect(directorySearchWithCount).toHaveBeenCalledTimes(1);
  });

  it('fails loud on a directory-search error (no masked partial set)', async () => {
    directorySearchWithCount.mockResolvedValueOnce({
      ok: false,
      error: { type: 'db_error' },
    });
    await expect(
      memberEnumerationAdapter.listActiveWithPlan(ctx),
    ).rejects.toThrow(/directory search failed/);
  });
});
