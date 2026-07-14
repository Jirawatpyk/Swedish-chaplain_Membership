/**
 * 059 / PR-A Task 3b — resolveVatSeed's three gates, pinned exhaustively
 * without rendering the form or driving a Base UI `<Select>` through
 * jsdom (see company-section.test.tsx for the rendering-level coverage —
 * static assertions only, for the same reason).
 */
import { describe, expect, it } from 'vitest';
import { resolveVatSeed } from '@/components/members/member-form/resolve-vat-seed';
import { LEGAL_ENTITY_TYPES, VAT_DEFAULT_BY_CODE } from '@/modules/members';

describe('resolveVatSeed (PR-A Task 3b)', () => {
  it('returns the recorded default for every catalogue code, edit mode, untouched', () => {
    for (const code of LEGAL_ENTITY_TYPES) {
      const expected = VAT_DEFAULT_BY_CODE[code];
      expect(
        resolveVatSeed({ mode: 'edit', code, vatManuallyTouched: false }),
      ).toBe(expected);
    }
  });

  // association / foundation have NO safe default — VAT registration
  // follows turnover, not legal form, and TSCC is itself a VAT-registered
  // association. Seeding either would be silently wrong.
  it('association has no safe default — never seeds', () => {
    expect(
      resolveVatSeed({ mode: 'edit', code: 'association', vatManuallyTouched: false }),
    ).toBeNull();
  });

  it('foundation has no safe default — never seeds', () => {
    expect(
      resolveVatSeed({ mode: 'edit', code: 'foundation', vatManuallyTouched: false }),
    ).toBeNull();
  });

  it('never seeds on create — is_vat_registered only renders in edit mode', () => {
    expect(
      resolveVatSeed({ mode: 'create', code: 'company', vatManuallyTouched: false }),
    ).toBeNull();
  });

  it('never seeds once the admin has hand-touched the checkbox this session', () => {
    expect(
      resolveVatSeed({ mode: 'edit', code: 'company', vatManuallyTouched: true }),
    ).toBeNull();
    // Even for a code whose default would otherwise be non-null.
    expect(
      resolveVatSeed({ mode: 'edit', code: 'limited_company', vatManuallyTouched: true }),
    ).toBeNull();
  });

  it('an out-of-catalogue code never seeds (defensive — the Select cannot actually produce one)', () => {
    expect(
      resolveVatSeed({ mode: 'edit', code: 'nonsense', vatManuallyTouched: false }),
    ).toBeNull();
  });

  it('an empty string ("nothing picked") never seeds', () => {
    expect(
      resolveVatSeed({ mode: 'edit', code: '', vatManuallyTouched: false }),
    ).toBeNull();
  });
});
