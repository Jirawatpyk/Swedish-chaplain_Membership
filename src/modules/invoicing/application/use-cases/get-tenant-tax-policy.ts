/**
 * R7 consolidation — thin facade over `TenantSettingsRepo.getForIssue`
 * that returns ONLY the fiscal-policy fields (currency, VAT rate,
 * registration fee).
 *
 * Purpose: F2 plan module needs VAT + currency to render prices, but
 * has no business reading F4's legal identity / numbering / logo.
 * This facade gives F2 a minimal read surface without coupling it to
 * the full `TenantInvoiceSettingsView`.
 *
 * Cross-module dependency direction (Principle III):
 *   F2 plans  →  F4 invoicing  (plans depends on invoicing's fiscal
 *                               policy; invoicing does NOT depend on
 *                               plans)
 *
 * This aligns with F4 being the authoritative finance bounded
 * context, which F2 US5 AS2 acknowledged from the start ("invoice
 * VAT is frozen in F4 at issuance time").
 */
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { VatRate } from '../../domain/value-objects/vat-rate';

export interface TenantTaxPolicy {
  readonly currencyCode: string; // ISO 4217
  readonly vatRate: VatRate;
  readonly registrationFeeSatang: bigint;
}

export interface GetTenantTaxPolicyDeps {
  readonly tenantSettingsRepo: TenantSettingsRepo;
}

export async function getTenantTaxPolicy(
  deps: GetTenantTaxPolicyDeps,
  tenantId: string,
): Promise<TenantTaxPolicy | null> {
  const view = await deps.tenantSettingsRepo.getForIssue(tenantId);
  if (!view) return null;
  return {
    currencyCode: view.currencyCode,
    vatRate: view.vatRate,
    registrationFeeSatang: view.registrationFeeSatang,
  };
}
