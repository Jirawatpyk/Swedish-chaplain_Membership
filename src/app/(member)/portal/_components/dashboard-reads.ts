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

/**
 * Most-recent renewal cycle for the session member. Cached per request.
 *
 * Returns the cycle, `null` for a genuine no-cycle (first-run) member, or
 * the `'error'` sentinel when the read FAILED (Result `!ok`). The two latter
 * cases were previously both collapsed to `null` (F4) — a DB-throw then
 * rendered the "Welcome aboard" first-run state and hid an overdue signal.
 */
export const loadDashboardRenewalCycle = cache(
  async (
    tenantId: string,
    memberId: string,
  ): Promise<RenewalCycle | 'error' | null> => {
    const deps = makeRenewalsDeps(tenantId);
    const res = await loadMemberRenewalStatus(deps, {
      tenantId,
      memberId,
    });
    if (!res.ok) return 'error';
    return res.value.cycle;
  },
);

/**
 * Benefit usage VO for the session member.
 *
 * Returns the VO, or the `'error'` sentinel when computeBenefitUsage returned
 * !ok. Previously collapsed to `null` (Defer 1 D1 code review) — `null` is
 * now unused here; the caller distinguishes error from genuine empty via the
 * sentinel so a transient failure is not shown as "No benefits yet".
 */
export const loadDashboardBenefitUsage = cache(
  async (
    ctx: TenantContext,
    memberId: string,
  ): Promise<BenefitUsage | 'error'> => {
    const res = await computeBenefitUsage(
      ctx,
      { memberId },
      makeComputeBenefitUsageDeps(ctx.slug),
    );
    return res.ok ? res.value : 'error';
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

/**
 * Result of the outstanding read.
 *
 * `total` is the server-reported issued-invoice count for the member.
 * `partial` is true when the page cap clipped the result (`total > inputs
 * length`) — the section then flags the figure as a floor rather than
 * silently under-reporting (F6). `error` is true when the read FAILED, so
 * callers can show an "unavailable" state instead of a misleading "all paid"
 * (F4, applied to outstanding too — cheap).
 */
export interface DashboardOutstandingRead {
  readonly inputs: OutstandingInvoiceInput[];
  readonly total: number;
  readonly partial: boolean;
  readonly error: boolean;
}

/** The page cap for the member's issued invoices. */
const OUTSTANDING_PAGE_SIZE = 100;

/** The member's unpaid invoices (issued only). Cached per request. */
export const loadDashboardOutstanding = cache(
  async (
    tenantId: string,
    memberId: string,
  ): Promise<DashboardOutstandingRead> => {
    const res = await listInvoicesPaged(makeListInvoicesDeps(tenantId), {
      tenantId,
      offset: 0,
      // Repo-honoured cap (the use-case schema maxes at 100). A member with
      // >100 unpaid issued invoices is a pathological state; we report the
      // figure as a partial floor (F6) rather than over-reading.
      pageSize: OUTSTANDING_PAGE_SIZE,
      includeDrafts: false,
      memberId,
      status: 'issued',
    });
    if (!res.ok) {
      return { inputs: [], total: 0, partial: false, error: true };
    }
    const inputs = toOutstandingInvoiceInputs(res.value.rows);
    return {
      inputs,
      total: res.value.total,
      partial: res.value.total > inputs.length,
      error: false,
    };
  },
);
