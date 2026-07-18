/**
 * 107-auto-invoice Task 7 — F8 → F4 tenant auto-invoice settings lookup
 * port.
 *
 * The daily `autoDraftDueRenewals` cron needs the tenant's three-key
 * dark-ship gate (`tenant_invoice_settings.auto_invoice_enabled`) plus
 * its lead-day / page-size cadence config
 * (`auto_invoice_lead_days_rolling/_calendar`, `auto_invoice_page_size`
 * — Task 1) BEFORE it can even call
 * `cyclesRepo.listCyclesEligibleForAutoDraft`, which takes those three
 * numbers as args.
 *
 * Narrow single-method port (mirrors `FiscalYearStartMonthPort`'s
 * shape) so F8's Application layer stays free of F4 ORM/schema imports
 * — the Infrastructure adapter reads F4's PUBLIC
 * `readAutoInvoiceSettingsForTenant` (already exported from
 * `@/modules/invoicing`), never a deep import.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
export interface AutoInvoiceSettingsView {
  readonly enabled: boolean;
  readonly leadDaysRolling: number;
  readonly leadDaysCalendar: number;
  readonly pageSize: number;
}

export interface AutoInvoiceSettingsPort {
  /**
   * Returns `null` when the tenant has no `tenant_invoice_settings` row
   * yet (pre-F4-setup tenant) — the caller treats a `null` result
   * identically to `enabled: false` (the three-key dark-ship default:
   * no auto-draft behaviour in prod until every key is explicitly
   * turned on). Never throws on a missing row; only a genuine
   * infrastructure failure propagates.
   */
  getAutoInvoiceSettings(
    tenantId: string,
  ): Promise<AutoInvoiceSettingsView | null>;
}
