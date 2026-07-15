/**
 * Review fix (Task 3b review, Finding 1) — `legal_entity_type` was closed to
 * the 12-code catalogue on the admin FORM only (client-side `z.enum` in
 * schema.ts); the server-side `createMemberSchema` still accepted any
 * `z.string()`. A direct API caller could therefore still store an
 * arbitrary string, which the fail-soft label resolver then prints
 * verbatim (raw snake_case) on the member page — defeating the whole
 * point of the catalogue closure. This pins the server boundary shut.
 */
import { describe, expect, it } from 'vitest';
import { createMemberSchema } from '@/modules/members/application/use-cases/create-member';
import { LEGAL_ENTITY_TYPES } from '@/modules/members/domain/value-objects/legal-entity-type';

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

describe('createMemberSchema — legal_entity_type is closed to the catalogue', () => {
  it('rejects an out-of-catalogue string (a direct API caller bypassing the form Select)', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      legal_entity_type: 'sole_proprietorship', // plausible typo of 'sole_proprietor'
    });
    expect(result.success).toBe(false);
  });

  it('rejects the pre-catalogue free-text style value', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      legal_entity_type: 'Co., Ltd.',
    });
    expect(result.success).toBe(false);
  });

  it('accepts every code in the closed catalogue', () => {
    for (const code of LEGAL_ENTITY_TYPES) {
      const result = createMemberSchema.safeParse({
        ...baseInput,
        legal_entity_type: code,
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.legal_entity_type).toBe(code);
    }
  });

  it('accepts null (explicitly unset)', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      legal_entity_type: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts omitted (undefined) — 10 of TSCC\'s 150 members have no recorded type', () => {
    const result = createMemberSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
  });

  it('accepts "" — the client Select\'s "nothing picked" sentinel value', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      legal_entity_type: '',
    });
    expect(result.success).toBe(true);
  });
});
