/**
 * T054 — TenantPaymentSettingsRepo port (F5 Application).
 */
import type { TenantPaymentSettings } from '../../domain/tenant-payment-settings';

export interface TenantPaymentSettingsRepo {
  /**
   * Read the row for the given tenant. Returns null when no row exists
   * (tenant never completed initial configuration) — use-case maps to
   * `tenant_settings_incomplete` error.
   *
   * Adapter MAY cache this result for a short TTL (≤ 60s) since the row
   * mutates rarely and every `initiatePayment` call reads it.
   */
  getByTenantId(tenantId: string): Promise<TenantPaymentSettings | null>;

  /**
   * Webhook-side tenant resolution (stripe-webhook.md § 3 step 7).
   * Resolve tenant by `processor_account_id` (the Stripe Connect
   * account on the webhook event). Returns null when no tenant owns
   * the account id — webhook returns 200 + `acknowledged_only`.
   */
  findByProcessorAccountId(processorAccountId: string): Promise<TenantPaymentSettings | null>;
}
