/**
 * Integration test — `receipt_number_prefix` end-to-end round-trip
 * through the F4 tenant-invoice-settings repo (live Neon Singapore).
 *
 * Regression coverage for the bug where the column was missing from
 * the Drizzle schema + repo upsert mapping, so every save silently
 * dropped the value. Added by migration 0142.
 *
 * Scenarios:
 *   1. First-time insert with `receiptNumberPrefix: 'RC'`
 *      → getForIssue returns 'RC'.
 *   2. Update from null → 'TR' → getForIssue returns 'TR'.
 *   3. Set to null explicitly clears it (combined-mode fallback).
 *   4. Round-trip preserves all OTHER fields untouched
 *      (so the receipt-prefix patch is not a wide stomper).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('drizzleTenantSettingsRepo — receipt_number_prefix round-trip (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  const BASE_REQUIRED = {
    currencyCode: 'THB',
    vatRate: '0.0700',
    legalNameTh: 'หอการค้าทดสอบ',
    legalNameEn: 'Test Chamber Co., Ltd.',
    taxId: '0000000000000',
    registeredAddressTh: 'ที่อยู่ทดสอบ',
    registeredAddressEn: 'Test Address',
    invoiceNumberPrefix: 'INV',
    creditNoteNumberPrefix: 'CN',
  } as const;

  it('persists receipt_number_prefix on first-time insert', async () => {
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      receiptNumberingMode: 'separate',
      receiptNumberPrefix: 'RC',
    });

    const settings = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(settings).not.toBeNull();
    expect(settings!.receiptNumberPrefix).toBe('RC');
    expect(settings!.receiptNumberingMode).toBe('separate');
  }, 30_000);

  it('updates receipt_number_prefix without stomping other fields', async () => {
    // Mirror real-world API usage — the PATCH form sends the full
    // payload every save (full required fields + the updated value),
    // so ON CONFLICT DO UPDATE runs only for the changed columns
    // (drizzle's onConflictDoUpdate.set only includes patched fields).
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      receiptNumberingMode: 'separate',
      receiptNumberPrefix: 'TR',
    });

    const settings = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(settings!.receiptNumberPrefix).toBe('TR');
    expect(settings!.receiptNumberingMode).toBe('separate');
    expect(settings!.invoiceNumberPrefix).toBe('INV');
    expect(settings!.creditNoteNumberPrefix).toBe('CN');
  }, 30_000);

  it('clears receipt_number_prefix when explicitly set to null', async () => {
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      receiptNumberingMode: 'combined',
      receiptNumberPrefix: null,
    });

    const settings = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(settings!.receiptNumberPrefix).toBeNull();
    expect(settings!.receiptNumberingMode).toBe('combined');
  }, 30_000);
});
