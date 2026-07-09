/**
 * FIX-3 (PR #173 review, 2026-07-09) — F8 → F4 tenant fiscal-year-start-month
 * lookup port.
 *
 * `reanchorFirstPaymentCycleInTx`'s FY-crossing boundary check
 * (`deriveFiscalYear(cycle.periodFrom)` vs `deriveFiscalYear(anchorDate)`)
 * previously called `deriveFiscalYear` with NO `startMonth` argument, which
 * silently defaults to `1` (January) — correct for SweCham (Jan-start) but
 * WRONG for any future tenant configured with a non-January
 * `tenant_invoice_settings.fiscal_year_start_month` (the same setting F4's
 * own `createInvoiceDraft` / `issueInvoice` / `record-payment` read via
 * `TenantSettingsRepo.getForIssue`). A tenant with e.g. an April-start
 * fiscal year could re-anchor a payment that crosses ITS April boundary
 * without ever re-freezing the plan's price/term for the new year.
 *
 * Narrow single-method port (mirrors `PlanLookupForRenewalPort`'s shape) so
 * F8's Application layer stays free of F4 ORM/schema imports — the
 * Infrastructure adapter reads F4's PUBLIC `drizzleTenantSettingsRepo`
 * (already exported from `@/modules/invoicing`), never a deep import.
 */
export interface FiscalYearStartMonthPort {
  /**
   * Returns the tenant's configured `fiscal_year_start_month` (1-12).
   * Falls back to `1` (January) with a loud log if the tenant has no
   * `tenant_invoice_settings` row yet (pre-F4-setup tenant) or the stored
   * value is out of range — never throws, since a missing/malformed
   * setting must not block a real member payment from settling.
   */
  getFiscalYearStartMonth(tenantId: string): Promise<number>;
}
