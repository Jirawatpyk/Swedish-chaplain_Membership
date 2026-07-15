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
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
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
 * Three-way result (D1 review finding C):
 *  - the VO — `computeBenefitUsage` ok;
 *  - `null` — `member_not_found` (a BENIGN "member has no benefit basis", e.g.
 *    a plan-less member). This is NOT a failure — the section renders the
 *    neutral "No benefits yet" empty state. `member_not_found` is NOT logged
 *    (it is an expected steady state for some members, not an operability
 *    signal), matching the use-case which does not log it either;
 *  - `'error'` — a genuine `compute_failed` (or an unexpected throw). Logged
 *    so operators see the diagnostic; the section renders the distinct
 *    transient-failure "Benefits unavailable" warning.
 */
export const loadDashboardBenefitUsage = cache(
  async (
    ctx: TenantContext,
    memberId: string,
  ): Promise<BenefitUsage | 'error' | null> => {
    let res;
    try {
      res = await computeBenefitUsage(
        ctx,
        { memberId },
        makeComputeBenefitUsageDeps(ctx.slug),
      );
    } catch (e) {
      logger.warn(
        { tenantId: ctx.slug, memberId, errKind: errKind(e) },
        '[dashboard-benefits] computeBenefitUsage threw — Benefits unavailable',
      );
      return 'error';
    }
    if (res.ok) return res.value;
    // Benign no-plan → neutral empty (not a warning). Distinct from a real
    // compute failure so a plan-less member is not shown "Benefits unavailable".
    if (res.error.code === 'member_not_found') return null;
    logger.warn(
      {
        tenantId: ctx.slug,
        memberId,
        errKind: errKind(rootCause(res.error)),
      },
      '[dashboard-benefits] computeBenefitUsage failed — Benefits unavailable',
    );
    return 'error';
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
    // 059-membership-suspension — carried through so the smart-CTA helper
    // can find an unpaid MEMBERSHIP invoice without a second DB read.
    id: r.invoiceId,
    invoiceSubject: r.invoiceSubject,
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

/** Sentinel returned on a failed/clipped read — shared by both failure exits. */
const OUTSTANDING_ERROR_READ: DashboardOutstandingRead = {
  inputs: [],
  total: 0,
  partial: false,
  error: true,
};

/** The member's unpaid invoices (issued only). Cached per request. */
export const loadDashboardOutstanding = cache(
  async (
    tenantId: string,
    memberId: string,
  ): Promise<DashboardOutstandingRead> => {
    // 057 R2 finding C — `listInvoicesPaged` is typed `Result<…, never>` and
    // has NO try/catch: a DB error THROWS rather than returning `!ok`, so the
    // `!res.ok` branch alone never fires on a real failure and the section
    // would CRASH instead of showing "Balance unavailable". Wrap the call so a
    // thrown read resolves to the same error sentinel the other dashboard
    // reads (renewal/benefit) already return — keeping the section resilient.
    let res;
    try {
      res = await listInvoicesPaged(makeListInvoicesDeps(tenantId), {
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
    } catch (e) {
      // D1 review finding B1 — the bare `catch {}` was silent. Log the failure
      // class so operators see WHY the Balance card reads "unavailable" instead
      // of "all paid". errKind only — never the raw error/SQL/PII.
      logger.warn(
        { tenantId, memberId, errKind: errKind(e) },
        '[dashboard-outstanding] listInvoicesPaged threw — Balance unavailable',
      );
      return OUTSTANDING_ERROR_READ;
    }
    if (!res.ok) {
      return OUTSTANDING_ERROR_READ;
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
