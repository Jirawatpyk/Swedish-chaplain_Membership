/**
 * 124 invoice dashboard (`/admin/finance`) — one loader per card. Figures and
 * the date range each card reads: spec 124 § Figure definitions, US1, US3.3.
 *
 * Each loader returns its own `Result`, so one failing query blanks one card,
 * never the page (US5.3); the fault is logged as `err: errKind(e)` (a DB
 * message can carry SQL) beside the reference id the card shows. `today` and
 * `now` are taken once per request by the caller. Collected in FY, By method
 * and the trend's Collected read the same FY range clamped to `today`, so the
 * rows and the months add up to the tile (the trend's Billed keeps the whole
 * FY). The role cut is made here (US4): without `invoicing.write` the
 * draft counts are ABSENT, not zeroed, and Record payment is not offered.
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { FiscalYearStartMonth } from '@/lib/fiscal-year';
import { allocatePercentages } from '@/lib/allocate-percentages';
import type { TenantContext } from '@/modules/tenants';
import {
  AGING_BUCKETS,
  agingBucketDueRange,
  type AgingBucket,
  type DueDateRange,
} from '../../domain/invoice-dashboard-aging';
import type { InvoiceDashboardFilters } from '../../domain/invoice-dashboard-filters';
import {
  calendarMonthRange,
  fiscalYearMonthSlots,
  type FiscalMonthSlotState,
  type FiscalYearDateRange,
} from '../../domain/invoice-dashboard-fiscal-year';
import {
  INVOICE_DASHBOARD_METHODS,
  type DashboardDateRange,
  type InvoiceDashboardMethod,
  type InvoiceDashboardSource,
  type OverdueInvoiceRow,
} from '../ports/invoice-dashboard-source';

export interface InvoiceDashboardLoadInput {
  readonly filters: InvoiceDashboardFilters;
  /** Bangkok today, `YYYY-MM-DD`, computed once per request (`bangkokLocalDate`). */
  readonly today: string;
  /**
   * The request instant, taken once with `today`; the pending-refund age in
   * Needs attention is measured from it, never the database's clock.
   */
  readonly now: Date;
  /** The selected FY, from `fiscalYearDateRange(filters.fiscalYear, startMonth)`. */
  readonly fiscalYearRange: FiscalYearDateRange;
  /** The viewer holds `invoicing.write` (decided by the caller via `canPerform`). */
  readonly canWrite: boolean;
}

export interface LoadInvoiceDashboardDeps {
  readonly source: InvoiceDashboardSource;
  /** The id a failed card shows and the log line carries. */
  readonly newReferenceId: () => string;
}

export interface InvoiceDashboardLoadError {
  readonly code: 'query_failed';
  readonly referenceId: string;
}

export type InvoiceDashboardResult<T> = Result<T, InvoiceDashboardLoadError>;

export interface AmountAndCount {
  readonly amountSatang: bigint;
  readonly count: number;
}

export interface InvoiceDashboardTiles {
  readonly outstanding: AmountAndCount;
  readonly overdue: AmountAndCount;
  readonly collectedThisMonth: {
    readonly amountSatang: bigint;
    readonly invoiceCount: number;
    /** The 1st of today's Bangkok month to `today` (spec US1: "{Month} to date"). */
    readonly range: DashboardDateRange;
    /** Always true: the month is read to today. */
    readonly toDate: true;
  };
  readonly collectedInFiscalYear: {
    readonly amountSatang: bigint;
    readonly invoiceCount: number;
    readonly range: DashboardDateRange;
    /** True when the range was cut at `today` (the current FY). */
    readonly toDate: boolean;
  };
}

export interface InvoiceDashboardAgingRow {
  readonly bucket: AgingBucket;
  readonly amountSatang: bigint;
  readonly count: number;
  /** Largest-remainder share of AMOUNT; the five add up to 100 when any is non-zero. */
  readonly sharePercent: number;
  /** The `/admin/invoices` query this bucket's row links to (US2.2). */
  readonly listQuery: InvoiceDashboardAgingListQuery;
}

/**
 * An aging bucket's drill-down: `issued` for "Not yet due", `overdue` for the
 * rest, plus the bucket's due-date range, so a link can never list paid or
 * void invoices; and the active filters in the `/admin/invoices` vocabulary
 * (`subject`, `plan`, `origin`, each absent when unfiltered), so a drill-down
 * never widens past the card it came from.
 */
export interface InvoiceDashboardAgingListQuery extends DueDateRange {
  readonly status: 'issued' | 'overdue';
  readonly subject?: 'membership' | 'event';
  readonly plan?: string;
  readonly origin?: 'manual' | 'auto_renewal';
}

/** The active filters as `/admin/invoices` query keys, unfiltered keys absent. */
function listFilterQuery(
  filters: InvoiceDashboardFilters,
): Pick<InvoiceDashboardAgingListQuery, 'subject' | 'plan' | 'origin'> {
  return {
    ...(filters.type !== 'all' ? { subject: filters.type } : {}),
    ...(filters.planId !== null ? { plan: filters.planId } : {}),
    ...(filters.origin !== 'all' ? { origin: filters.origin } : {}),
  };
}

export interface InvoiceDashboardAging {
  readonly totalSatang: bigint;
  readonly count: number;
  readonly buckets: readonly InvoiceDashboardAgingRow[];
}

/** Needs attention as every viewer sees it. */
export interface InvoiceDashboardAttentionReadOnly {
  readonly receiptPdfFailed: number;
  readonly refundsFailedAtStripe: number;
  readonly refundsPendingOverThreshold: number;
}

/** Needs attention for a viewer holding `invoicing.write`. */
export interface InvoiceDashboardAttentionWithDrafts extends InvoiceDashboardAttentionReadOnly {
  readonly drafts: { readonly manual: number; readonly autoRenewal: number };
}

export type InvoiceDashboardAttention =
  | InvoiceDashboardAttentionReadOnly
  | InvoiceDashboardAttentionWithDrafts;

export interface InvoiceDashboardOldestOverdue {
  readonly rows: readonly OverdueInvoiceRow[];
  /** Whether the Record payment action is offered (admins only). */
  readonly canRecordPayment: boolean;
}

export interface InvoiceDashboardTrendSlot {
  readonly monthKey: string;
  readonly from: string;
  readonly to: string;
  readonly state: FiscalMonthSlotState;
  /** null for a month still to come. */
  readonly billedSatang: bigint | null;
  readonly collectedSatang: bigint | null;
}

export interface InvoiceDashboardTrend {
  /** The whole FY: the slots and the Billed series. */
  readonly range: DashboardDateRange;
  /** The Collected series' range: the FY cut at `today` (as Collected in FY). */
  readonly collectedRange: DashboardDateRange;
  /** True when `collectedRange` was cut at `today` (the current FY). */
  readonly toDate: boolean;
  readonly slots: readonly InvoiceDashboardTrendSlot[];
}

export interface InvoiceDashboardMethodRow {
  readonly method: InvoiceDashboardMethod;
  readonly amountSatang: bigint;
  /**
   * Largest-remainder share of AMOUNT over the POSITIVE rows only: a negative
   * or zero row (e.g. this FY's credit notes on last FY's invoices) gets 0,
   * and the positive rows' shares add up to 100 (all 0 when none is positive).
   */
  readonly sharePercent: number;
}

export interface InvoiceDashboardMethods {
  readonly range: DashboardDateRange;
  /** True when `range` was cut at `today` (the current FY). */
  readonly toDate: boolean;
  /** Σ rows — equals Collected in FY for the same filters. */
  readonly totalSatang: bigint;
  readonly rows: readonly InvoiceDashboardMethodRow[];
}

/** Spec US1: "Oldest overdue (6 rows)". A caller may ask for 1–50 (the phone shows 3). */
export const OLDEST_OVERDUE_DEFAULT_LIMIT = 6;
const OLDEST_OVERDUE_MAX_LIMIT = 50;

async function guarded<T>(
  card: string,
  ctx: TenantContext,
  deps: LoadInvoiceDashboardDeps,
  run: () => Promise<T>,
): Promise<InvoiceDashboardResult<T>> {
  try {
    return ok(await run());
  } catch (e) {
    const referenceId = deps.newReferenceId();
    logger.error(
      { err: errKind(e), referenceId, tenantId: ctx.slug, card },
      `insights.invoice_dashboard.${card}.failed`,
    );
    return err({ code: 'query_failed', referenceId });
  }
}

/**
 * `range` cut at `today` when today falls inside it (`toDate`); otherwise the
 * whole range. The one clamp behind every "to date" figure: the FY cards and
 * the this-month tile.
 */
function rangeToDate(
  range: DashboardDateRange,
  today: string,
): { readonly range: DashboardDateRange; readonly toDate: boolean } {
  const toDate = today >= range.from && today <= range.to;
  return { range: { from: range.from, to: toDate ? today : range.to }, toDate };
}

async function readAging(
  ctx: TenantContext,
  input: InvoiceDashboardLoadInput,
  deps: LoadInvoiceDashboardDeps,
): Promise<InvoiceDashboardAging> {
  const totals = await deps.source.outstandingByAgingBucket(ctx, input.filters, input.today);
  const byBucket = new Map(totals.map((t) => [t.bucket, t]));
  const rows = AGING_BUCKETS.map((bucket) => ({
    bucket,
    amountSatang: byBucket.get(bucket)?.amountSatang ?? 0n,
    count: byBucket.get(bucket)?.count ?? 0,
  }));
  const shares = allocatePercentages(rows.map((r) => Number(r.amountSatang)));
  const filterQuery = listFilterQuery(input.filters);
  return {
    totalSatang: rows.reduce((sum, r) => sum + r.amountSatang, 0n),
    count: rows.reduce((sum, r) => sum + r.count, 0),
    buckets: rows.map((r, i) => ({
      ...r,
      sharePercent: shares[i] ?? 0,
      listQuery: {
        status: r.bucket === 'not_yet_due' ? ('issued' as const) : ('overdue' as const),
        ...agingBucketDueRange(r.bucket, input.today),
        ...filterQuery,
      },
    })),
  };
}

export function loadInvoiceDashboardTiles(
  ctx: TenantContext,
  input: InvoiceDashboardLoadInput,
  deps: LoadInvoiceDashboardDeps,
): Promise<InvoiceDashboardResult<InvoiceDashboardTiles>> {
  return guarded('tiles', ctx, deps, async () => {
    // Today's calendar month, cut at today ("{Month} to date"); today always
    // lies inside its own month, so `toDate` is always true there.
    const month = rangeToDate(calendarMonthRange(input.today), input.today).range;
    const fy = rangeToDate(input.fiscalYearRange, input.today);
    const [aging, collectedMonth, collectedFy] = await Promise.all([
      readAging(ctx, input, deps),
      deps.source.collectedInRange(ctx, input.filters, month),
      deps.source.collectedInRange(ctx, input.filters, fy.range),
    ]);
    const overdueRows = aging.buckets.filter((b) => b.bucket !== 'not_yet_due');
    return {
      outstanding: { amountSatang: aging.totalSatang, count: aging.count },
      overdue: {
        amountSatang: overdueRows.reduce((sum, b) => sum + b.amountSatang, 0n),
        count: overdueRows.reduce((sum, b) => sum + b.count, 0),
      },
      collectedThisMonth: { ...collectedMonth, range: month, toDate: true },
      collectedInFiscalYear: { ...collectedFy, range: fy.range, toDate: fy.toDate },
    };
  });
}

export function loadInvoiceDashboardAging(
  ctx: TenantContext,
  input: InvoiceDashboardLoadInput,
  deps: LoadInvoiceDashboardDeps,
): Promise<InvoiceDashboardResult<InvoiceDashboardAging>> {
  return guarded('aging', ctx, deps, () => readAging(ctx, input, deps));
}

export function loadInvoiceDashboardAttention(
  ctx: TenantContext,
  input: InvoiceDashboardLoadInput,
  deps: LoadInvoiceDashboardDeps,
): Promise<InvoiceDashboardResult<InvoiceDashboardAttention>> {
  return guarded('attention', ctx, deps, async () => {
    const counts = await deps.source.attentionCounts(ctx, input.filters, input.now);
    const readOnly: InvoiceDashboardAttentionReadOnly = {
      receiptPdfFailed: counts.receiptPdfFailed,
      refundsFailedAtStripe: counts.refundsFailedAtStripe,
      refundsPendingOverThreshold: counts.refundsPendingOverThreshold,
    };
    if (!input.canWrite) return readOnly;
    return {
      ...readOnly,
      drafts: { manual: counts.manualDrafts, autoRenewal: counts.autoRenewalDrafts },
    };
  });
}

export function loadInvoiceDashboardOldestOverdue(
  ctx: TenantContext,
  input: InvoiceDashboardLoadInput,
  deps: LoadInvoiceDashboardDeps,
  limit: number = OLDEST_OVERDUE_DEFAULT_LIMIT,
): Promise<InvoiceDashboardResult<InvoiceDashboardOldestOverdue>> {
  const safeLimit =
    Number.isInteger(limit) && limit >= 1 && limit <= OLDEST_OVERDUE_MAX_LIMIT
      ? limit
      : OLDEST_OVERDUE_DEFAULT_LIMIT;
  return guarded('oldest_overdue', ctx, deps, async () => ({
    rows: await deps.source.oldestOverdue(ctx, input.filters, input.today, safeLimit),
    canRecordPayment: input.canWrite,
  }));
}

export function loadInvoiceDashboardTrend(
  ctx: TenantContext,
  input: InvoiceDashboardLoadInput,
  deps: LoadInvoiceDashboardDeps,
): Promise<InvoiceDashboardResult<InvoiceDashboardTrend>> {
  return guarded('trend', ctx, deps, async () => {
    const { fiscalYear, from, to } = input.fiscalYearRange;
    const range = { from, to };
    const collected = rangeToDate(input.fiscalYearRange, input.today);
    const months = await deps.source.monthlyBilledCollected(ctx, input.filters, range, collected.range);
    const byMonth = new Map(months.map((m) => [m.monthKey, m]));
    const startMonth = Number(from.slice(5, 7)) as FiscalYearStartMonth;
    const slots = fiscalYearMonthSlots(fiscalYear, startMonth, input.today).map((slot) => {
      if (slot.state === 'future') {
        return { ...slot, billedSatang: null, collectedSatang: null };
      }
      const m = byMonth.get(slot.monthKey);
      return { ...slot, billedSatang: m?.billedSatang ?? 0n, collectedSatang: m?.collectedSatang ?? 0n };
    });
    return { range, collectedRange: collected.range, toDate: collected.toDate, slots };
  });
}

function normaliseMethod(raw: string | null): InvoiceDashboardMethod {
  return (INVOICE_DASHBOARD_METHODS as readonly string[]).includes(raw ?? '')
    ? (raw as InvoiceDashboardMethod)
    : 'other';
}

export function loadInvoiceDashboardMethods(
  ctx: TenantContext,
  input: InvoiceDashboardLoadInput,
  deps: LoadInvoiceDashboardDeps,
): Promise<InvoiceDashboardResult<InvoiceDashboardMethods>> {
  return guarded('methods', ctx, deps, async () => {
    const { range, toDate } = rangeToDate(input.fiscalYearRange, input.today);
    const raw = await deps.source.collectedByMethod(ctx, input.filters, range);
    const sums = new Map<InvoiceDashboardMethod, bigint>();
    for (const r of raw) {
      const method = normaliseMethod(r.method);
      sums.set(method, (sums.get(method) ?? 0n) + r.amountSatang);
    }
    const amounts = INVOICE_DASHBOARD_METHODS.map((method) => sums.get(method) ?? 0n);
    // Shares over the positive rows: one negative row must not zero them all.
    const shares = allocatePercentages(amounts.map((a) => (a > 0n ? Number(a) : 0)));
    const rows = INVOICE_DASHBOARD_METHODS.map((method, i) => ({
      method,
      amountSatang: amounts[i] ?? 0n,
      sharePercent: shares[i] ?? 0,
    }));
    return {
      range,
      toDate,
      totalSatang: rows.reduce((sum, r) => sum + r.amountSatang, 0n),
      rows,
    };
  });
}
