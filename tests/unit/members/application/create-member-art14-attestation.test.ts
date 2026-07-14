/**
 * Task 8 — GDPR Art. 14 attestation gate on `createMemberSchema`'s
 * `secondary_contact` block.
 *
 * A secondary contact's data is supplied by the admin, not by the person
 * themselves (a third party under GDPR Art. 14). The admin must attest they
 * informed that person before the request is allowed to proceed —
 * `art14_attested: z.literal(true)` on the schema means anything other than
 * a literal `true` (missing, `false`, `null`, a string) fails validation.
 *
 * No gate applies when `secondary_contact` is omitted entirely — the
 * primary contact is a first-party relationship (the member supplied their
 * own representative), so Art. 14 never applies to it.
 *
 * Live-Neon end-to-end coverage (DB round-trip, primary vs secondary
 * `art14_attested_at` values) lives in
 * `tests/integration/members/contact-art14-attestation.test.ts`.
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

const validSecondaryContact = {
  first_name: 'Björn',
  last_name: 'Svensson',
  email: 'bjorn@acme.example',
  preferred_language: 'sv' as const,
};

describe('createMemberSchema — GDPR Art. 14 attestation gate (Task 8)', () => {
  it('accepts no secondary_contact at all — no gate applies to the primary', () => {
    const result = createMemberSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
  });

  it('rejects a secondary_contact with art14_attested entirely missing', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      secondary_contact: validSecondaryContact,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.path.join('.') === 'secondary_contact.art14_attested',
        ),
      ).toBe(true);
    }
  });

  it('rejects a secondary_contact with art14_attested: false', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      secondary_contact: { ...validSecondaryContact, art14_attested: false },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a secondary_contact with art14_attested as a non-boolean truthy value', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      secondary_contact: { ...validSecondaryContact, art14_attested: 'yes' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a secondary_contact with art14_attested: true', () => {
    const result = createMemberSchema.safeParse({
      ...baseInput,
      secondary_contact: { ...validSecondaryContact, art14_attested: true },
    });
    expect(result.success).toBe(true);
  });
});
