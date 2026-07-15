/**
 * 088-invoice-tax-flow-redesign (T044 / US5) — WHT note + seller §86/4 branch +
 * offline-payment bank block round-trip through the F4 tenant-invoice-settings
 * repo (live Neon Singapore).
 *
 * Validates migration 0233 (13 new columns + `tenant_invoice_settings_seller_branch_ck`)
 * together with the repo `copyFields` (upsert) + `rowToView` (read) mapping: the
 * new columns must persist through `upsert()` and read back on the PINNED
 * `TenantIdentitySnapshot` (`identity.*`) — which is exactly what `issue-invoice`
 * copies into the immutable invoice snapshot at issue (FR-011), so the template
 * renders the tenant WHT note + bank block from stored bytes, never live settings.
 *
 * T037 (contract) mocks the repo and T038 (template) drives the element tree with
 * a hand-built snapshot, so this is the ONLY coverage that the DB columns +
 * mapping actually round-trip against real Postgres (mocks hide schema gaps —
 * see the F4 R8 gotcha).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('drizzleTenantSettingsRepo — WHT + seller-branch + bank round-trip (live Neon)', () => {
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
    receiptNumberingMode: 'separate' as const,
    receiptNumberPrefix: 'RC',
  };

  it('persists the WHT note + bank block + head-office seller on first insert', async () => {
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      whtNoteTh: 'ยกเว้น ณ ที่จ่าย',
      whtNoteEn: 'No withholding tax applies.',
      sellerIsHeadOffice: true,
      sellerBranchCode: null,
      bankPayeeName: 'Thai-Swedish Chamber of Commerce',
      bankAccountNo: '005-3-92003-9',
      bankAccountType: 'Savings',
      bankName: 'Kasikorn Bank',
      bankBranch: 'Emquartier',
      bankAddress: 'Sukhumvit 35, Bangkok',
      bankSwift: 'KASITHBK',
      paymentInstructionsTh: 'ขีดคร่อม A/C Payee Only',
      paymentInstructionsEn: 'Account Payee Only.',
    });

    const s = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(s).not.toBeNull();
    const id = s!.identity;
    expect(id.wht_note_th).toBe('ยกเว้น ณ ที่จ่าย');
    expect(id.wht_note_en).toBe('No withholding tax applies.');
    expect(id.seller_is_head_office).toBe(true);
    expect(id.seller_branch_code).toBeNull();
    expect(id.bank_payee_name).toBe('Thai-Swedish Chamber of Commerce');
    expect(id.bank_account_no).toBe('005-3-92003-9');
    expect(id.bank_account_type).toBe('Savings');
    expect(id.bank_name).toBe('Kasikorn Bank');
    expect(id.bank_branch).toBe('Emquartier');
    expect(id.bank_address).toBe('Sukhumvit 35, Bangkok');
    expect(id.bank_swift).toBe('KASITHBK');
    expect(id.payment_instructions_th).toBe('ขีดคร่อม A/C Payee Only');
    expect(id.payment_instructions_en).toBe('Account Payee Only.');
  }, 30_000);

  it('switches the seller to a branch with a 5-digit code (CHECK holds)', async () => {
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      sellerIsHeadOffice: false,
      sellerBranchCode: '00007',
    });
    const s = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(s!.identity.seller_is_head_office).toBe(false);
    expect(s!.identity.seller_branch_code).toBe('00007');
  }, 30_000);

  it('clears the WHT note + bank fields when set to null (and reverts to head office)', async () => {
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      sellerIsHeadOffice: true,
      sellerBranchCode: null,
      whtNoteTh: null,
      whtNoteEn: null,
      bankAccountNo: null,
      bankSwift: null,
    });
    const s = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(s!.identity.wht_note_th).toBeNull();
    expect(s!.identity.wht_note_en).toBeNull();
    expect(s!.identity.bank_account_no).toBeNull();
    expect(s!.identity.bank_swift).toBeNull();
    // unrelated fields untouched (patch is not a wide stomper)
    expect(s!.identity.legal_name_en).toBe('Test Chamber Co., Ltd.');
    expect(s!.invoiceNumberPrefix).toBe('INV');
  }, 30_000);

  it('065 §5.4 — persists + reads back the statutory termination notice via the pinned snapshot', async () => {
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      terminationNoticeTh: 'PLACEHOLDER: SweCham มีหน้าที่ยุติสมาชิกภาพผู้ค้างชำระภายใน 60 วัน',
      terminationNoticeEn: 'PLACEHOLDER: SweCham is regulatory-bound to terminate unpaid members.',
    });
    const s = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(s).not.toBeNull();
    expect(s!.identity.termination_notice_th).toBe(
      'PLACEHOLDER: SweCham มีหน้าที่ยุติสมาชิกภาพผู้ค้างชำระภายใน 60 วัน',
    );
    expect(s!.identity.termination_notice_en).toBe(
      'PLACEHOLDER: SweCham is regulatory-bound to terminate unpaid members.',
    );

    // Clearing to null removes it (partial PATCH, unrelated fields untouched).
    await drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
      ...BASE_REQUIRED,
      terminationNoticeTh: null,
      terminationNoticeEn: null,
    });
    const cleared = await drizzleTenantSettingsRepo.getForIssue(tenant.ctx.slug);
    expect(cleared!.identity.termination_notice_th).toBeNull();
    expect(cleared!.identity.termination_notice_en).toBeNull();
  }, 30_000);

  it('DB CHECK rejects a branch seller with a NULL branch code (defense-in-depth)', async () => {
    await expect(
      drizzleTenantSettingsRepo.upsert(tenant.ctx.slug, {
        ...BASE_REQUIRED,
        sellerIsHeadOffice: false,
        sellerBranchCode: null,
      }),
    ).rejects.toThrow();
  }, 30_000);
});
