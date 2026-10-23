/**
 * 124 — where each dashboard figure leads (spec US2). Every link carries the
 * active Invoice type / Plan / Origin filters in the invoice list's own
 * vocabulary (`subject`, `plan`, `origin`), so the list's count equals the
 * figure it came from under any filter (US2.5). Pure; client-safe.
 */

/** The `/admin/invoices` query keys a dashboard link may set. */
export interface InvoiceListQuery {
  readonly status?: 'issued' | 'overdue' | 'draft';
  readonly dueAfter?: string;
  readonly dueBefore?: string;
  readonly subject?: 'membership' | 'event';
  readonly plan?: string;
  readonly origin?: 'manual' | 'auto_renewal';
}

const KEY_ORDER = ['status', 'dueAfter', 'dueBefore', 'subject', 'plan', 'origin'] as const;

/** `/admin/invoices?…` with the keys in a fixed order; absent keys are left out. */
export function invoiceListHref(query: InvoiceListQuery): string {
  const params = new URLSearchParams();
  for (const key of KEY_ORDER) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/admin/invoices?${qs}` : '/admin/invoices';
}

/**
 * Export CSV for the selected FY (US2.6): the existing export route, from the
 * FY's first day to the earlier of its last day and today.
 */
export function exportCsvHref(fiscalYear: { readonly from: string; readonly to: string }, today: string): string {
  const to = fiscalYear.to < today ? fiscalYear.to : today;
  const params = new URLSearchParams({ from: fiscalYear.from, to });
  return `/api/admin/invoices/export.csv?${params.toString()}`;
}
