/**
 * Unit — 124: `listPlanNames`, the lean plan-name read the admin invoice
 * list's `?plan=` chip uses (no tax-policy read, no VAT math). Soft-deleted
 * plans are included: a deleted plan can still carry unpaid invoices.
 */
import { describe, it, expect, vi } from 'vitest';
import { listPlanNames, asPlanYear, type PlanRepo } from '@/modules/plans';
import type { TenantContext } from '@/modules/tenants';

const tenant = { slug: 'acme' } as unknown as TenantContext;

function repo(impl: PlanRepo['findByTenantAndYear']) {
  return { findByTenantAndYear: vi.fn(impl) } as unknown as PlanRepo & {
    findByTenantAndYear: ReturnType<typeof vi.fn>;
  };
}

describe('listPlanNames', () => {
  it('returns id + name for the year, deleted plans included', async () => {
    const planRepo = repo(async () => [
      { plan_id: 'gold', plan_name: { en: 'Gold' } },
      { plan_id: 'old', plan_name: { en: 'Old' } },
    ] as never);
    const res = await listPlanNames({ year: asPlanYear(2026) }, { tenant, planRepo });
    expect(res).toEqual({
      ok: true,
      value: [
        { plan_id: 'gold', plan_name: { en: 'Gold' } },
        { plan_id: 'old', plan_name: { en: 'Old' } },
      ],
    });
    expect(planRepo.findByTenantAndYear).toHaveBeenCalledWith(tenant, {
      year: 2026,
      showDeleted: true,
    });
  });

  it('a repo fault is a server_error, not a throw', async () => {
    const planRepo = repo(async () => {
      throw new Error('connection lost');
    });
    const res = await listPlanNames({ year: asPlanYear(2026) }, { tenant, planRepo });
    expect(res).toEqual({ ok: false, error: { type: 'server_error', message: 'connection lost' } });
  });
});
