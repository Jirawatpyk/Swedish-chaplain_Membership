/**
 * `TenantFeeConfig` — per-tenant authoritative currency + VAT + registration fee.
 *
 * See data-model.md § 2.3. Exactly one row per tenant. The currency
 * code on this row is the **single authoritative currency** for every
 * money field in the tenant's catalogue (critique P3 — per-plan
 * currency is deliberately NOT stored in F2).
 *
 * Pure TypeScript — no framework imports.
 */

import type { CurrencyCode } from './money';
import type { TenantSlug } from './plan';

export type TenantFeeConfig = {
  readonly tenant_id: TenantSlug;

  /**
   * ISO 4217 currency code. **Immutable in F2 once plans exist**
   * (critique R1) — the `update-fee-config` use case rejects
   * attempts to change this field with `422 currency_code_immutable_in_f2`
   * when non-deleted plans exist.
   */
  readonly currency_code: CurrencyCode;

  /**
   * Decimal VAT rate in the range [0, 1). 0.0700 = 7%. Stored as
   * numeric(5,4) in Postgres.
   */
  readonly vat_rate: number;

  /**
   * One-time new-member fee in the tenant's currency's minor units.
   * SweCham example: 100000 = 1,000.00 THB.
   */
  readonly registration_fee_minor_units: number;

  readonly updated_at: Date;
  readonly updated_by: string; // UUID from F1 users
};
