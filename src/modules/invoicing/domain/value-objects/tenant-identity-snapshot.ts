/**
 * T027 — Tenant identity snapshot (F4).
 *
 * Copied onto the invoice at issue time and rendered into the PDF
 * bilingual header. Immutable once the invoice leaves draft state
 * (enforced by the `invoices_enforce_immutability_trg` DB trigger).
 *
 * Fields come from `tenant_invoice_settings` at the moment of issue —
 * subsequent settings changes do NOT retroactively alter historical
 * invoices (FR-011).
 */
export interface TenantIdentitySnapshot {
  readonly legal_name_th: string;
  readonly legal_name_en: string;
  readonly tax_id: string;
  readonly address_th: string;
  readonly address_en: string;
  readonly logo_blob_key: string | null;
}

export function makeTenantIdentitySnapshot(parts: TenantIdentitySnapshot): TenantIdentitySnapshot {
  // Return a frozen shallow copy — callers should not mutate.
  return Object.freeze({ ...parts });
}
