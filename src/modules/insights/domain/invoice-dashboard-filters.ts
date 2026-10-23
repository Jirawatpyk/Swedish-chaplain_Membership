/**
 * 124 invoice dashboard — the URL filter state (`type`, `fy`, `plan`,
 * `origin`; spec US3). Pure, no framework imports.
 *
 * Values use the invoice list's own vocabulary (`subject` membership | event,
 * `origin` manual | auto_renewal) so every drill-down link carries them
 * through unchanged and the list count equals the figure (US2).
 *
 * Rules:
 *   - A Plan sets Invoice type to Membership; with Invoice type = Events the
 *     plan is dropped (the Plan filter is hidden there).
 *   - Fiscal year: the current FY and the two before; anything else → current.
 *   - Unknown values, and a repeated param, fall back to the default — never
 *     an error page.
 *   - `origin` is honoured only while auto-invoicing is on (the Origin filter
 *     is shown only then).
 *   - Plan ids: any well-formed id passes through as-is, including one this
 *     year's plans do not know — it filters (and may match nothing), it never
 *     widens to every plan (spec D-i). Whether the dashboard's Plan picker
 *     names such an id is a slice-3 question; the parser does not decide it.
 */
import { parsePlanIdParam } from '@/lib/plan-id-param';

export type InvoiceDashboardType = 'all' | 'membership' | 'event';
export type InvoiceDashboardOrigin = 'all' | 'manual' | 'auto_renewal';

export interface InvoiceDashboardFilters {
  readonly type: InvoiceDashboardType;
  readonly fiscalYear: number;
  /** null = all plans. Non-null implies `type === 'membership'`. */
  readonly planId: string | null;
  readonly origin: InvoiceDashboardOrigin;
}

/** A raw search-param value as Next.js hands it over. */
export type DashboardSearchParam = string | readonly string[] | undefined;

export interface InvoiceDashboardSearchParams {
  readonly type?: DashboardSearchParam;
  readonly fy?: DashboardSearchParam;
  readonly plan?: DashboardSearchParam;
  readonly origin?: DashboardSearchParam;
}

export interface InvoiceDashboardFilterContext {
  /** The tenant's current fiscal year (Bangkok), e.g. `deriveFiscalYear(nowIso, startMonth)`. */
  readonly currentFiscalYear: number;
  /** `FEATURE_AUTO_INVOICE` — the Origin filter exists only while it is on. */
  readonly autoInvoiceEnabled: boolean;
}

/** The selectable fiscal years, newest first: the current FY and the two before. */
export function selectableFiscalYears(currentFiscalYear: number): readonly number[] {
  return [currentFiscalYear, currentFiscalYear - 1, currentFiscalYear - 2];
}

function single(raw: DashboardSearchParam): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function parseType(raw: string | undefined): InvoiceDashboardType {
  return raw === 'membership' || raw === 'event' ? raw : 'all';
}

function parseOrigin(raw: string | undefined, enabled: boolean): InvoiceDashboardOrigin {
  if (!enabled) return 'all';
  return raw === 'manual' || raw === 'auto_renewal' ? raw : 'all';
}

function parseFiscalYear(raw: string | undefined, current: number): number {
  if (raw === undefined || !/^\d{4}$/.test(raw)) return current;
  const fy = Number(raw);
  return selectableFiscalYears(current).includes(fy) ? fy : current;
}

export function parseInvoiceDashboardFilters(
  params: InvoiceDashboardSearchParams,
  ctx: InvoiceDashboardFilterContext,
): InvoiceDashboardFilters {
  const requestedType = parseType(single(params.type));
  const planId = requestedType === 'event' ? undefined : parsePlanIdParam(single(params.plan));
  return {
    type: planId === undefined ? requestedType : 'membership',
    fiscalYear: parseFiscalYear(single(params.fy), ctx.currentFiscalYear),
    planId: planId ?? null,
    origin: parseOrigin(single(params.origin), ctx.autoInvoiceEnabled),
  };
}
