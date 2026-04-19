/**
 * T032 — Fee config port (F4).
 *
 * SINGLE SOURCE OF TRUTH for the tenant's VAT + registration fee is
 * F2's `tenant_fee_config`. This port is a read-through adapter that
 * lets F4 use cases consume that authoritative config without leaking
 * F2's internal types. The F4 `tenant_invoice_settings` table has a
 * `registration_fee_satang` column that is **deprecated** and should
 * not be read by new code — kept only for migration back-compat
 * until a Phase 10 cleanup lands.
 */

export interface TenantFeeConfigView {
  /** Currency ISO code (F2 is immutable once plans exist). */
  readonly currencyCode: string;
  /** Decimal VAT rate, e.g. 0.0700 for 7%. */
  readonly vatRate: string;
  /** One-time new-member fee in MINOR units (THB satang for SweCham). */
  readonly registrationFeeMinorUnits: bigint;
}

export interface FeeConfigPort {
  getByTenant(tenantId: string): Promise<TenantFeeConfigView | null>;
}
