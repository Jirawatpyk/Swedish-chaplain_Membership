/**
 * T051 — Drizzle tenant_invoice_settings repo (F4).
 *
 * Read path — `getForIssue` loads a snapshot for invoice issuance.
 *
 * Write path — R7-B2 adds `upsert` backing the US4 settings UI
 * (PATCH /api/tenant-invoice-settings). A single INSERT … ON CONFLICT
 * DO UPDATE patches only the columns explicitly present in the patch,
 * so partial edits don't overwrite unrelated fields with stale values.
 */
import { eq, sql } from 'drizzle-orm';
import type {
  TenantSettingsRepo,
  TenantInvoiceSettingsView,
  TenantInvoiceSettingsPatch,
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

  async upsert(tenantId: string, patch: TenantInvoiceSettingsPatch): Promise<void> {
    const ctx = asTenantContext(tenantId);
    // Build the patch row — only caller-provided fields are included in
    // the UPDATE SET. Required fields for INSERT are supplied only if
    // the caller provided them; on first-time insert, missing required
    // fields surface as a DB NOT NULL violation (caller validates
    // upstream).
    const insertValues: Record<string, unknown> = { tenantId };
    const updateValues: Record<string, unknown> = { updatedAt: sql`now()` };
    const copyFields: Array<[keyof TenantInvoiceSettingsPatch, string]> = [
      ['vatRate', 'vatRate'],
      ['registrationFeeSatang', 'registrationFeeSatang'],
      ['legalNameTh', 'legalNameTh'],
      ['legalNameEn', 'legalNameEn'],
      ['taxId', 'taxId'],
      ['registeredAddressTh', 'registeredAddressTh'],
      ['registeredAddressEn', 'registeredAddressEn'],
      ['invoiceNumberPrefix', 'invoiceNumberPrefix'],
      ['creditNoteNumberPrefix', 'creditNoteNumberPrefix'],
      ['receiptNumberingMode', 'receiptNumberingMode'],
      ['fiscalYearStartMonth', 'fiscalYearStartMonth'],
      ['defaultNetDays', 'defaultNetDays'],
      ['proRatePolicy', 'proRatePolicy'],
      ['autoEmailEnabled', 'autoEmailEnabled'],
      ['logoBlobKey', 'logoBlobKey'],
    ];
    for (const [src, dst] of copyFields) {
      if (patch[src] !== undefined) {
        insertValues[dst] = patch[src];
        updateValues[dst] = patch[src];
      }
    }

    await runInTenant(ctx, (tx) =>
      tx
        .insert(tenantInvoiceSettings)
        .values(insertValues as typeof tenantInvoiceSettings.$inferInsert)
        .onConflictDoUpdate({
          target: tenantInvoiceSettings.tenantId,
          set: updateValues,
        }),
    );
  },
};
