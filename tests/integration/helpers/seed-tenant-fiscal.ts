/**
 * R9-T1 — shared seed helper for tenant fiscal config in integration
 * tests. After the R8 Option-2 consolidation, `tenant_invoice_settings`
 * is the single source of truth for currency + VAT + registration fee.
 * This helper replaces the legacy per-test `feeConfigRepo.upsert()` +
 * direct `tx.insert(tenantFeeConfig)` seed calls that predated the
 * consolidation.
 *
 * Minimum-viable placeholders mirror migration 0028's backfill —
 * admin is expected to replace them via /admin/settings/invoicing
 * before issuing invoices; tests that exercise issuance flows should
 * override the relevant fields.
 */
import { runInTenant } from '@/lib/db';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { TestTenant } from './test-tenant';

export interface SeedTenantFiscalInput {
  readonly tenant: TestTenant;
  readonly currencyCode?: string;
  /** 4-dp decimal string (e.g. "0.0700"). */
  readonly vatRate?: string;
  readonly registrationFeeSatang?: bigint;
  readonly invoiceNumberPrefix?: string;
  readonly creditNoteNumberPrefix?: string;
  /**
   * Wave-4 S18 — §86/4 receipt-stream prefix (separate-mode / as-paid β tests).
   * Omitted → column default (NULL; the §86/4 'receipt' register falls back to
   * 'RC' since 088 US7 — disjoint from the §105 'receipt_105'/'RE' register).
   */
  readonly receiptNumberPrefix?: string;
  readonly legalNameTh?: string;
  readonly legalNameEn?: string;
  readonly taxId?: string;
  readonly registeredAddressTh?: string;
  readonly registeredAddressEn?: string;
  /** Fiscal-year start month (1-12). Omitted → column default (1 = Jan, FY==CE). */
  readonly fiscalYearStartMonth?: number;
}

/**
 * Seeds a minimum-viable `tenant_invoice_settings` row for the given
 * test tenant. Called from `beforeAll` / `beforeEach` in integration
 * tests that would previously have seeded `tenant_fee_config`.
 *
 * Idempotent-ish: fails loudly if the row already exists (PK
 * violation) so a test that calls this twice gets a clear error —
 * intentional, since a second seed usually signals a test-isolation
 * bug.
 */
export async function seedTenantFiscal(input: SeedTenantFiscalInput): Promise<void> {
  const { tenant } = input;
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(tenantInvoiceSettings).values({
      tenantId: tenant.ctx.slug,
      currencyCode: input.currencyCode ?? 'THB',
      vatRate: input.vatRate ?? '0.0700',
      registrationFeeSatang: input.registrationFeeSatang ?? 0n,
      legalNameTh: input.legalNameTh ?? 'Test TH',
      legalNameEn: input.legalNameEn ?? 'Test EN',
      taxId: input.taxId ?? '0000000000000',
      registeredAddressTh: input.registeredAddressTh ?? 'Test Address TH',
      registeredAddressEn: input.registeredAddressEn ?? 'Test Address EN',
      invoiceNumberPrefix: input.invoiceNumberPrefix ?? 'INV',
      creditNoteNumberPrefix: input.creditNoteNumberPrefix ?? 'CN',
      ...(input.receiptNumberPrefix !== undefined
        ? { receiptNumberPrefix: input.receiptNumberPrefix }
        : {}),
      ...(input.fiscalYearStartMonth !== undefined
        ? { fiscalYearStartMonth: input.fiscalYearStartMonth }
        : {}),
    }),
  );
}
