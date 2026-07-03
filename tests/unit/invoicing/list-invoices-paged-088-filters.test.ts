/**
 * Unit — 088 T065b: `listInvoicesPagedSchema` gains three OPTIONAL admin-list
 * filter fields (FR-031, ภพ.30 support):
 *
 *   - `documentType`  — SC bill / RC §86/4 tax-receipt / RE §105 legacy receipt
 *                        / CN credit-note (cross-reference to credited invoices).
 *   - `taxPointState` — pre_payment (bill awaiting payment) vs at_payment
 *                        (§86/4 / §105 receipt issued → tax point reached).
 *   - `vatTreatment`  — standard vs zero_rated_80_1_5 (§80/1(5)).
 *
 * These are ADMIN-only 088 filters (gated on `FEATURE_088_TAX_AT_PAYMENT` at the
 * page). The schema must parse the valid values, reject unknown ones, and keep
 * every field OPTIONAL (absent ⇒ undefined, existing callers unaffected).
 */
import { describe, it, expect } from 'vitest';
import { listInvoicesPagedSchema } from '@/modules/invoicing';

describe('listInvoicesPagedSchema — 088 T065b document/tax-point/vat filters', () => {
  const base = { tenantId: 'acme' } as const;

  it('parses documentType sc|rc|re|cn', () => {
    for (const v of ['sc', 'rc', 're', 'cn'] as const) {
      const parsed = listInvoicesPagedSchema.parse({ ...base, documentType: v });
      expect(parsed.documentType).toBe(v);
    }
  });

  it('parses taxPointState pre_payment|at_payment', () => {
    for (const v of ['pre_payment', 'at_payment'] as const) {
      const parsed = listInvoicesPagedSchema.parse({ ...base, taxPointState: v });
      expect(parsed.taxPointState).toBe(v);
    }
  });

  it('parses vatTreatment standard|zero_rated_80_1_5', () => {
    for (const v of ['standard', 'zero_rated_80_1_5'] as const) {
      const parsed = listInvoicesPagedSchema.parse({ ...base, vatTreatment: v });
      expect(parsed.vatTreatment).toBe(v);
    }
  });

  it('rejects an unknown documentType', () => {
    const r = listInvoicesPagedSchema.safeParse({ ...base, documentType: 'xx' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown taxPointState', () => {
    const r = listInvoicesPagedSchema.safeParse({ ...base, taxPointState: 'later' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown vatTreatment', () => {
    const r = listInvoicesPagedSchema.safeParse({ ...base, vatTreatment: 'exempt' });
    expect(r.success).toBe(false);
  });

  it('keeps all three fields optional (absent ⇒ undefined)', () => {
    const parsed = listInvoicesPagedSchema.parse(base);
    expect(parsed.documentType).toBeUndefined();
    expect(parsed.taxPointState).toBeUndefined();
    expect(parsed.vatTreatment).toBeUndefined();
  });
});
