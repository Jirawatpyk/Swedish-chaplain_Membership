/**
 * 088 US7 (review fix) — `receiptNumberPrefix` reserved-token guard.
 *
 * The §86/4 RC-role tax-receipt register and the §105 `receipt_105` register
 * BOTH write their rendered number into `invoices.receipt_document_number_raw`
 * and share ONE partial unique index `invoices_tenant_receipt_raw_uniq
 * (tenant_id, receipt_document_number_raw)` that is NOT partitioned by
 * document_type. The two registers are separate counters (each seq starts at 1
 * per fiscal year). The §105 register uses a HARDCODED 'RE' prefix. If a tenant
 * configured `receiptNumberPrefix='RE'` for its §86/4 receipts, both registers
 * would render `RE-{fy}-000001` and the second commit would 23505.
 *
 * `updateTenantInvoiceSettingsSchema` therefore reserves 'RE' (case-
 * insensitive): it may ONLY be the §105 event-receipt prefix, never a §86/4
 * receipt prefix. A different §86/4 prefix such as 'RC' (the default) is fine.
 */
import { describe, it, expect } from 'vitest';
import { updateTenantInvoiceSettingsSchema } from '@/modules/invoicing/application/use-cases/update-tenant-invoice-settings';

const BASE = { tenantId: 'tenant-x', actorUserId: 'user-y' } as const;

describe('updateTenantInvoiceSettingsSchema — receiptNumberPrefix RE reservation (088 US7)', () => {
  it("rejects receiptNumberPrefix === 'RE' (reserved for the §105 register)", () => {
    const r = updateTenantInvoiceSettingsSchema.safeParse({
      ...BASE,
      receiptNumberPrefix: 'RE',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('receiptNumberPrefix'))).toBe(true);
    }
  });

  it("rejects a case-variant of 'RE' (re / rE) — the §105 register is uppercase-only", () => {
    for (const p of ['re', 'rE', 'Re', ' RE ']) {
      const r = updateTenantInvoiceSettingsSchema.safeParse({ ...BASE, receiptNumberPrefix: p });
      expect(r.success, `prefix ${JSON.stringify(p)} must be rejected`).toBe(false);
    }
  });

  it("accepts the §86/4 default 'RC'", () => {
    const r = updateTenantInvoiceSettingsSchema.safeParse({ ...BASE, receiptNumberPrefix: 'RC' });
    expect(r.success, r.success ? 'ok' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("accepts a non-reserved prefix such as 'INV'", () => {
    const r = updateTenantInvoiceSettingsSchema.safeParse({ ...BASE, receiptNumberPrefix: 'INV' });
    expect(r.success, r.success ? 'ok' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("accepts a prefix that merely starts with 'RE' but is not the reserved token (e.g. 'REG', 'RECEIPT')", () => {
    for (const p of ['REG', 'RECEIPT', 'REV']) {
      const r = updateTenantInvoiceSettingsSchema.safeParse({ ...BASE, receiptNumberPrefix: p });
      expect(r.success, `prefix ${p} must be accepted`).toBe(true);
    }
  });

  it('accepts null (clearing the separate-mode receipt prefix)', () => {
    const r = updateTenantInvoiceSettingsSchema.safeParse({ ...BASE, receiptNumberPrefix: null });
    expect(r.success, r.success ? 'ok' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it('accepts an omitted receiptNumberPrefix (partial PATCH untouched)', () => {
    const r = updateTenantInvoiceSettingsSchema.safeParse({ ...BASE, invoiceNumberPrefix: 'INV' });
    expect(r.success, r.success ? 'ok' : JSON.stringify(r.error.issues)).toBe(true);
  });
});

describe('updateTenantInvoiceSettingsSchema — statutory termination notice (065 §5.4)', () => {
  it('accepts termination_notice_th/_en text (mirrors whtNote shape)', () => {
    const r = updateTenantInvoiceSettingsSchema.safeParse({
      ...BASE,
      terminationNoticeTh: 'PLACEHOLDER: ยุติสมาชิกภาพภายใน 60 วัน',
      terminationNoticeEn: 'PLACEHOLDER: terminated within 60 days of the due date',
    });
    expect(r.success, r.success ? 'ok' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it('accepts null (clearing the notice) and rejects an over-length note (>500)', () => {
    const clear = updateTenantInvoiceSettingsSchema.safeParse({
      ...BASE,
      terminationNoticeTh: null,
      terminationNoticeEn: null,
    });
    expect(clear.success, clear.success ? 'ok' : JSON.stringify(clear.error.issues)).toBe(true);

    const tooLong = updateTenantInvoiceSettingsSchema.safeParse({
      ...BASE,
      terminationNoticeEn: 'x'.repeat(501),
    });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues.some((i) => i.path.includes('terminationNoticeEn'))).toBe(true);
    }
  });
});
