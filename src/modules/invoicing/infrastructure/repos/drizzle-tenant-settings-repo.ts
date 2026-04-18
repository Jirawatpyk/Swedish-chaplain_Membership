/**
 * T051 — Drizzle tenant_invoice_settings repo (F4).
 * Read-only for issue-time snapshotting. CRUD for US4 settings UI lives
 * in a separate use case (T093).
 */
import { eq } from 'drizzle-orm';
import type {
  TenantSettingsRepo,
  TenantInvoiceSettingsView,
} from '../../application/ports/tenant-settings-repo';
import { VatRate } from '../../domain/value-objects/vat-rate';
import { asProRatePolicyUnsafe } from '../../domain/value-objects/pro-rate-policy';
import { asTenantContext } from '@/modules/tenants';
import { runInTenant } from '@/lib/db';
import { tenantInvoiceSettings } from '../db';

export const drizzleTenantSettingsRepo: TenantSettingsRepo = {
  async getForIssue(tenantId: string): Promise<TenantInvoiceSettingsView | null> {
    const ctx = asTenantContext(tenantId);
    const rows = await runInTenant(ctx, (tx) =>
      tx.select().from(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, tenantId)).limit(1),
    );
    const row = rows[0];
    if (!row) return null;

    return {
      tenantId: row.tenantId,
      vatRate: VatRate.ofUnsafe(row.vatRate),
      registrationFeeSatang: BigInt(row.registrationFeeSatang as unknown as string),
      invoiceNumberPrefix: row.invoiceNumberPrefix,
      creditNoteNumberPrefix: row.creditNoteNumberPrefix,
      receiptNumberingMode: row.receiptNumberingMode === 'separate' ? 'separate' : 'combined',
      fiscalYearStartMonth: row.fiscalYearStartMonth,
      defaultNetDays: row.defaultNetDays,
      proRatePolicy: asProRatePolicyUnsafe(row.proRatePolicy),
      autoEmailEnabled: row.autoEmailEnabled,
      identity: Object.freeze({
        legal_name_th: row.legalNameTh,
        legal_name_en: row.legalNameEn,
        tax_id: row.taxId,
        address_th: row.registeredAddressTh,
        address_en: row.registeredAddressEn,
        logo_blob_key: row.logoBlobKey,
      }),
    };
  },
};
