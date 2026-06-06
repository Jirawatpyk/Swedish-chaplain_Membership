/**
 * 057 portal redesign §4.1 — per-request cached, RLS-safe dashboard reads.
 *
 * The Dashboard renders 3 stat sections + activity feed that each need the
 * same underlying data reads. React `cache()` memoises per request so each
 * read runs at most once per render (spec §4.1 + §9 "duplicate reads" risk).
 *
 * IMPORTANT: `tenantId` is an explicit cache-key argument so React's equality
 * check keying works correctly (same pattern as `cached-payment-activity.ts`).
 * Do NOT call `resolveTenantFromRequest()` inside the cache callback — tenant
 * is not part of the memoisation key then, creating a cross-tenant data risk.
 *
 * Constitution Principle I (tenant isolation): all reads go through module
 * barrels; the underlying Drizzle adapters wrap queries in `runInTenant`.
 */
import { cache } from 'react';
import {
  loadMemberRenewalStatus,
  makeRenewalsDeps,
  type RenewalCycle,
} from '@/modules/renewals';
import {
  computeBenefitUsage,
  makeComputeBenefitUsageDeps,
  type BenefitUsage,
} from '@/modules/insights';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
  type Invoice,
} from '@/modules/invoicing';
import type { TenantContext } from '@/modules/tenants';
import type { OutstandingInvoiceInput } from '../_lib/dashboard-stats';

/** Most-recent renewal cycle for the session member, or null. Cached per request. */
export const loadDashboardRenewalCycle = cache(
  async (
    tenantId: string,
    memberId: string,
  ): Promise<RenewalCycle | null> => {
    const deps = makeRenewalsDeps(tenantId);
    const res = await loadMemberRenewalStatus(deps, {
      tenantId,
      memberId,
    });
    return res.ok ? res.value.cycle : null;
  },
);

/** Benefit usage VO for the session member, or null on a genuine compute failure. */
export const loadDashboardBenefitUsage = cache(
  async (
    ctx: TenantContext,
    memberId: string,
  ): Promise<BenefitUsage | null> => {
    const res = await computeBenefitUsage(
      ctx,
      { memberId },
      makeComputeBenefitUsageDeps(ctx.slug),
    );
    return res.ok ? res.value : null;
  },
);

/** Map F4 Invoice rows to the pure outstanding-stat shape (extracted for unit test). */
export function toOutstandingInvoiceInputs(
  rows: readonly Invoice[],
): OutstandingInvoiceInput[] {
  return rows.map((r) => ({
    status: r.status,
    totalSatang: r.total?.satang ?? null,
    dueDate: r.dueDate,
  }));
}

/** The member's unpaid invoices (issued only). Cached per request. */
export const loadDashboardOutstanding = cache(
  async (
    tenantId: string,
    memberId: string,
  ): Promise<OutstandingInvoiceInput[]> => {
    const res = await listInvoicesPaged(makeListInvoicesDeps(tenantId), {
      tenantId,
      offset: 0,
      pageSize: 200,
      includeDrafts: false,
      memberId,
      status: 'issued',
    });
    return res.ok ? toOutstandingInvoiceInputs(res.value.rows) : [];
  },
);
