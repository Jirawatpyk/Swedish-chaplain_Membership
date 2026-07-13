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

describe('createMemberSchema — notes', () => {
  it('accepts notes and preserves the value', () => {
    const parsed = createMemberSchema.parse({
      ...baseInput,
      notes: 'Paid by bank transfer, VIP',
    });

    expect(parsed.notes).toBe('Paid by bank transfer, VIP');
  });

  it('leaves notes undefined when omitted', () => {
    const parsed = createMemberSchema.parse(baseInput);

    expect(parsed.notes).toBeUndefined();
  });

  it('rejects notes longer than 4000 characters', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      notes: 'x'.repeat(4001),
    });

    expect(result.success).toBe(false);
  });
});
