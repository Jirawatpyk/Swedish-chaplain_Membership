/**
 * F114 T018 — validation parity (FR-006, research R14 + § V1).
 *
 * "Proposed values MUST pass the validation that applies to a staff edit of
 * the same field." Parity is a MECHANISM, not a sentence: the Domain
 * `field-rules.ts` exports one zod rule per Group B key and the STAFF server
 * schemas (`updateMemberSchema`, `updateContactFieldsSchema`) build their
 * Group B entries from those same exports. This test asserts REFERENCE
 * equality (`toBe`) per key, so a rule edited on one side without the other
 * cannot compile-drift silently — the two paths literally share one object.
 *
 * Phone: the staff path applies `asPhone` after zod; `validateProposal`
 * applies the same value object, pinned behaviourally below.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONTACT_FIELD_RULES,
  MEMBER_FIELD_RULES,
  REGISTERED_ADDRESS_LINE_RULES,
  BILLING_ADDRESS_LINE_RULES,
  normalizeWebsiteUrl,
  validateProposal,
} from '@/modules/members/domain/change-request/field-rules';
import { updateMemberSchema } from '@/modules/members/application/use-cases/update-member';
import { updateContactFieldsSchema } from '@/modules/members/application/use-cases/contact-crud';
import { asPhone } from '@/modules/members/domain/value-objects/phone';

function memberShape(): Record<string, z.ZodTypeAny> {
  // `updateMemberSchema` ends in `.superRefine(...)` → a ZodEffects; unwrap.
  const inner = updateMemberSchema instanceof z.ZodEffects ? updateMemberSchema.innerType() : updateMemberSchema;
  return (inner as z.ZodObject<z.ZodRawShape>).shape;
}

describe('Group B field rules are the staff server rules (reference-equal)', () => {
  it('member scalar keys: company_name / website / description', () => {
    const shape = memberShape();
    expect(shape['company_name']).toBe(MEMBER_FIELD_RULES.company_name);
    expect(shape['website']).toBe(MEMBER_FIELD_RULES.website);
    expect(shape['description']).toBe(MEMBER_FIELD_RULES.description);
  });

  it('registered address lines map onto the staff address_* rules', () => {
    const shape = memberShape();
    expect(shape['address_line1']).toBe(REGISTERED_ADDRESS_LINE_RULES.line1);
    expect(shape['address_line2']).toBe(REGISTERED_ADDRESS_LINE_RULES.line2);
    expect(shape['sub_district']).toBe(REGISTERED_ADDRESS_LINE_RULES.sub_district);
    expect(shape['city']).toBe(REGISTERED_ADDRESS_LINE_RULES.city);
    expect(shape['province']).toBe(REGISTERED_ADDRESS_LINE_RULES.province);
    expect(shape['postal_code']).toBe(REGISTERED_ADDRESS_LINE_RULES.postal_code);
  });

  it('billing address lines map onto the staff billing_* rules, country included', () => {
    const shape = memberShape();
    expect(shape['billing_address_line1']).toBe(BILLING_ADDRESS_LINE_RULES.line1);
    expect(shape['billing_address_line2']).toBe(BILLING_ADDRESS_LINE_RULES.line2);
    expect(shape['billing_sub_district']).toBe(BILLING_ADDRESS_LINE_RULES.sub_district);
    expect(shape['billing_city']).toBe(BILLING_ADDRESS_LINE_RULES.city);
    expect(shape['billing_province']).toBe(BILLING_ADDRESS_LINE_RULES.province);
    expect(shape['billing_postal_code']).toBe(BILLING_ADDRESS_LINE_RULES.postal_code);
    expect(shape['billing_country']).toBe(BILLING_ADDRESS_LINE_RULES.country);
  });

  it('contact keys: first_name / last_name / phone / role_title', () => {
    const shape = updateContactFieldsSchema.shape;
    expect(shape.first_name).toBe(CONTACT_FIELD_RULES.first_name);
    expect(shape.last_name).toBe(CONTACT_FIELD_RULES.last_name);
    expect(shape.phone).toBe(CONTACT_FIELD_RULES.phone);
    expect(shape.role_title).toBe(CONTACT_FIELD_RULES.role_title);
  });
});

describe('validateProposal (the member-side gate over the same rules)', () => {
  it('accepts a well-formed proposal and normalises it (trim, "" website → null, phone E.164)', () => {
    const r = validateProposal({
      contact: { first_name: '  Anna ', phone: '+66 81 234 5678' },
      company: { website: '', description: 'A chamber member' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contact?.first_name).toBe('Anna');
    expect(r.value.contact?.phone).toBe(asPhone('+66 81 234 5678').ok ? (asPhone('+66 81 234 5678') as { value: string }).value : 'unreachable');
    expect(r.value.company?.website).toBeNull();
    expect(r.value.company?.description).toBe('A chamber member');
  });

  it('refuses the US1 AS4 examples with field-level issues', () => {
    const bad = validateProposal({
      contact: { phone: 'not-a-phone' },
      company: { website: 'javascript:alert(1)', company_name: 'x'.repeat(201), description: 'y'.repeat(2001) },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const paths = bad.error.map((i) => i.path.join('.')).sort();
    expect(paths).toEqual(['company.company_name', 'company.description', 'company.website', 'contact.phone']);
  });

  it('applies the staff website rule: a bare domain is normalised, a non-URL is refused', () => {
    const okr = validateProposal({ company: { website: 'nordic.example' } });
    expect(okr.ok && okr.value.company?.website).toBe('https://nordic.example');
    const bad = validateProposal({ company: { website: 'not a url' } });
    expect(bad.ok).toBe(false);
    expect(normalizeWebsiteUrl('  facebook.com/x ')).toBe('https://facebook.com/x');
    expect(normalizeWebsiteUrl('http://a.b')).toBe('http://a.b');
    expect(normalizeWebsiteUrl(42)).toBe(42);
  });

  it('validates address groups line by line and refuses an unknown line', () => {
    const okr = validateProposal({
      company: {
        billing_address: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
      },
    });
    expect(okr.ok).toBe(true);
    const bad = validateProposal({
      company: { billing_address: { line1: 'Box 9', country: 'SWE' } },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.map((i) => i.path.join('.'))).toEqual(['company.billing_address.country']);
    const unknownLine = validateProposal({ company: { registered_address: { street: 'x' } } });
    expect(unknownLine.ok).toBe(false);
  });

  it('a null phone clears it without E.164 parsing; an empty company name is refused', () => {
    expect(validateProposal({ contact: { phone: null } }).ok).toBe(true);
    const bad = validateProposal({ company: { company_name: '   ' } });
    expect(bad.ok).toBe(false);
  });

  it('is strict: keys outside Group B are validation issues (the use case refuses them earlier as forged)', () => {
    const bad = validateProposal({ company: { tax_id: '0105551234567' } });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error[0]?.code).toBe('unrecognized_keys');
  });
});
