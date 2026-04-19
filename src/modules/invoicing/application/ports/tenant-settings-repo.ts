/**
 * T032 — Tenant invoice settings repository port (F4).
 */
import type { TenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import type { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { ProRatePolicy } from '@/modules/invoicing/domain/value-objects/pro-rate-policy';

export interface TenantInvoiceSettingsView {
  readonly tenantId: string;
  readonly vatRate: VatRate;
  readonly registrationFeeSatang: bigint;
  readonly invoiceNumberPrefix: string;
  readonly creditNoteNumberPrefix: string;
  /**
   * Receipt document-number prefix used only when
   * `receiptNumberingMode === 'separate'`. Nullable for backwards-compat
   * with tenants that have not configured a dedicated prefix yet — the
   * record-payment use case falls back to `'RE'` in that case.
   */
  readonly receiptNumberPrefix?: string | null;
  readonly receiptNumberingMode: 'combined' | 'separate';
  readonly fiscalYearStartMonth: number;
  readonly defaultNetDays: number;
  readonly proRatePolicy: ProRatePolicy;
  readonly autoEmailEnabled: boolean;
  readonly identity: TenantIdentitySnapshot;
}

export interface TenantSettingsRepo {
  /**
   * Load current settings for a tenant. Returns null if the settings
   * row does not yet exist — caller is expected to refuse issuance per
   * FR-010 ("no invoice without settings").
   */
  getForIssue(tenantId: string): Promise<TenantInvoiceSettingsView | null>;
}
