import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import { mapMemberCreateServerError } from '@/components/members/member-create-error-map';

/** Resolve a dot-path under the `admin.members.create` i18n namespace. */
function resolveCreateKey(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, k) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[k]
          : undefined,
      en.admin.members.create,
    );
}

describe('mapMemberCreateServerError', () => {
  it('routes a 409 unique-email conflict to the email field', () => {
    expect(mapMemberCreateServerError(409, 'conflict', undefined)).toEqual({
      field: 'primary_contact.email',
      messageKey: 'errors.emailInUse',
    });
  });

  // PR-B task 8 — the server now discriminates WHICH email collided via
  // `details.reason` instead of always assuming the primary contact.
  it('routes a 409 conflict with reason=secondary_email_in_use to the secondary field', () => {
    expect(
      mapMemberCreateServerError(
        409,
        'conflict',
        undefined,
        'secondary_email_in_use',
      ),
    ).toEqual({
      field: 'secondary_contact.email',
      messageKey: 'errors.secondaryEmailInUse',
    });
  });

  it.each([
    ['primary_email_in_use'],
    ['member_duplicate'],
    [undefined],
  ] as const)(
    'falls back to the primary email field for reason=%s',
    (reason) => {
      expect(
        mapMemberCreateServerError(409, 'conflict', undefined, reason),
      ).toEqual({
        field: 'primary_contact.email',
        messageKey: 'errors.emailInUse',
      });
    },
  );

  it('does NOT claim 409 soft_duplicate (its own confirm dialog owns it)', () => {
    expect(
      mapMemberCreateServerError(409, 'soft_duplicate', undefined),
    ).toBeNull();
  });

  it.each([
    ['invalid_email', 'primary_contact.email', 'fields.errors.emailFormat'],
    ['invalid_tax_id', 'tax_id', 'errors.taxIdInvalid'],
    ['invalid_phone', 'primary_contact.phone', 'fields.phoneError'],
    ['invalid_country', 'country', 'fields.errors.countryCode'],
    // 059 / PR-A Task 4 — update-member.ts's use-case-body registrant ⇒ TIN
    // check (defense-in-depth only; buildMemberFormSchema's own superRefine
    // blocks this before submit in the normal UI flow).
    [
      'vat_registrant_requires_tax_id',
      'tax_id',
      'fields.errors.taxIdRequiredForRegistrant',
    ],
    // 059 / PR-A Task 5 — update-member.ts's use-case-body branch ⇒
    // VAT-registrant check (same defense-in-depth posture as Task 4's row
    // directly above).
    [
      'branch_requires_vat_registrant',
      'branch_code',
      'fields.errors.branchOnNonRegistrant',
    ],
  ])('routes a 400 %s to its originating field', (type, field, messageKey) => {
    expect(mapMemberCreateServerError(400, 'validation_error', type)).toEqual({
      field,
      messageKey,
    });
  });

  it.each([
    [
      'invalid_secondary_email',
      'secondary_contact.email',
      'fields.errors.emailFormat',
    ],
    ['invalid_secondary_phone', 'secondary_contact.phone', 'fields.phoneError'],
  ])('routes a 400 %s to its originating secondary-contact field', (type, field, messageKey) => {
    expect(mapMemberCreateServerError(400, 'validation_error', type)).toEqual({
      field,
      messageKey,
    });
  });

  it('returns null for an unmapped 400 (other domain errors / invalid_body)', () => {
    expect(
      mapMemberCreateServerError(400, 'validation_error', 'invalid_override_reason'),
    ).toBeNull();
    expect(mapMemberCreateServerError(400, 'invalid_body', undefined)).toBeNull();
  });

  it('returns null for non-field-attributable statuses', () => {
    expect(mapMemberCreateServerError(403, 'forbidden', undefined)).toBeNull();
    expect(mapMemberCreateServerError(500, 'server_error', undefined)).toBeNull();
    expect(mapMemberCreateServerError(201, undefined, undefined)).toBeNull();
  });

  // Guards against a messageKey drifting away from the i18n catalogue — those
  // crash at runtime with MISSING_MESSAGE (next-intl), which unit mocks hide.
  it('every returned messageKey resolves to a string in en.json', () => {
    const mapped = [
      mapMemberCreateServerError(409, 'conflict', undefined),
      mapMemberCreateServerError(400, 'validation_error', 'invalid_email'),
      mapMemberCreateServerError(400, 'validation_error', 'invalid_tax_id'),
      mapMemberCreateServerError(400, 'validation_error', 'invalid_phone'),
      mapMemberCreateServerError(400, 'validation_error', 'invalid_country'),
      mapMemberCreateServerError(
        409,
        'conflict',
        undefined,
        'secondary_email_in_use',
      ),
      mapMemberCreateServerError(
        400,
        'validation_error',
        'invalid_secondary_email',
      ),
      mapMemberCreateServerError(
        400,
        'validation_error',
        'invalid_secondary_phone',
      ),
      mapMemberCreateServerError(
        400,
        'validation_error',
        'vat_registrant_requires_tax_id',
      ),
    ].filter((m): m is NonNullable<typeof m> => m !== null);

    expect(mapped).toHaveLength(9);
    for (const m of mapped) {
      expect(typeof resolveCreateKey(m.messageKey)).toBe('string');
    }
  });
});
