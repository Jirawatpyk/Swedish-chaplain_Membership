/**
 * 059 / PR-A Task 4 — registrant ⇒ TIN invariant (ประกาศอธิบดีฯ 196 + 199 are
 * a PAIR): a member created as a VAT registrant must also carry a tax_id, or
 * the §86/4 buyer block on a future tax document would print the branch line
 * with no taxpayer number.
 *
 * CREATE supplies the full record in one request (unlike updateMemberSchema's
 * PARTIAL patch — see update-member-vat-registrant.test.ts, where this same
 * rule has to live in the use-case body instead), so it fits cleanly on the
 * schema's own superRefine here.
 */
import { describe, expect, it } from 'vitest';
import { createMemberSchema } from '@/modules/members/application/use-cases/create-member';

const baseInput = {
  company_name: 'ACME Co., Ltd.',
  country: 'TH',
  plan_id: 'plan-corporate',
  plan_year: 2026,
  primary_contact: {
    first_name: 'Somchai',
    last_name: 'Jaidee',
    email: 'somchai@acme.example',
    preferred_language: 'en' as const,
  },
};

describe('createMemberSchema — registrant ⇒ TIN invariant (059 / PR-A Task 4)', () => {
  it('rejects is_vat_registered:true with no tax_id at all', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      is_vat_registered: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'tax_id'),
      ).toBe(true);
    }
  });

  it('rejects is_vat_registered:true with an explicit null tax_id', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      is_vat_registered: true,
      tax_id: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects is_vat_registered:true with a blank/whitespace-only tax_id', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      is_vat_registered: true,
      tax_id: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('accepts is_vat_registered:true WITH a tax_id', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      is_vat_registered: true,
      tax_id: '0105556012341',
    });
    expect(result.success).toBe(true);
  });

  it('accepts is_vat_registered:false with no tax_id — the common case', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      is_vat_registered: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts is_vat_registered omitted entirely (defaults false) with no tax_id', () => {
    const result = createMemberSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
  });
});
