/**
 * Review fix (Task 3b review, Finding 1) — same server-boundary closure as
 * create-member-legal-entity-type.test.ts, applied to `updateMemberSchema`.
 * An edit to an unrelated field must never be blocked by an unset/legacy
 * `legal_entity_type`, so `null` / undefined / '' must all still parse.
 */
import { describe, expect, it } from 'vitest';
import { updateMemberSchema } from '@/modules/members/application/use-cases/update-member';
import { LEGAL_ENTITY_TYPES } from '@/modules/members/domain/value-objects/legal-entity-type';

describe('updateMemberSchema — legal_entity_type is closed to the catalogue', () => {
  it('rejects an out-of-catalogue string (a direct API caller bypassing the form Select)', () => {
    const result = updateMemberSchema.safeParse({
      legal_entity_type: 'sole_proprietorship', // plausible typo of 'sole_proprietor'
    });
    expect(result.success).toBe(false);
  });

  it('rejects the pre-catalogue free-text style value', () => {
    const result = updateMemberSchema.safeParse({
      legal_entity_type: 'Co., Ltd.',
    });
    expect(result.success).toBe(false);
  });

  it('accepts every code in the closed catalogue', () => {
    for (const code of LEGAL_ENTITY_TYPES) {
      const result = updateMemberSchema.safeParse({ legal_entity_type: code });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.legal_entity_type).toBe(code);
    }
  });

  it('accepts null (explicitly unset)', () => {
    const result = updateMemberSchema.safeParse({ legal_entity_type: null });
    expect(result.success).toBe(true);
  });

  it('accepts omitted — an edit to an unrelated field must never be blocked by this one', () => {
    const result = updateMemberSchema.safeParse({ company_name: 'New Name Co.' });
    expect(result.success).toBe(true);
  });

  it('accepts "" — the client Select\'s "nothing picked" sentinel value', () => {
    const result = updateMemberSchema.safeParse({ legal_entity_type: '' });
    expect(result.success).toBe(true);
  });
});
