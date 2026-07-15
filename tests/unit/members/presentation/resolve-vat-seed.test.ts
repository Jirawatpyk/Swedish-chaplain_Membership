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
        resolveVatSeed({ code, vatManuallyTouched: false }),
      ).toBe(expected);
    }
  });

  // association / foundation have NO safe default — VAT registration
  // follows turnover, not legal form, and TSCC is itself a VAT-registered
  // association. Seeding either would be silently wrong.
  it('association has no safe default — never seeds', () => {
    expect(
      resolveVatSeed({ code: 'association', vatManuallyTouched: false }),
    ).toBeNull();
  });

  it('foundation has no safe default — never seeds', () => {
    expect(
      resolveVatSeed({ code: 'foundation', vatManuallyTouched: false }),
    ).toBeNull();
  });

  it('SEEDS ON CREATE TOO — the checkbox is no longer edit-only', () => {
    // This test used to assert the opposite ("never seeds on create"), and it was
    // right at the time: the VAT checkbox rendered only on edit, and the create
    // payload never carried the field, so seeding it would have been dead state.
    //
    // Both of those were the bug. `is_vat_registered` is what makes the buyer's
    // "สำนักงานใหญ่ / สาขาที่ NNNNN" line print (ประกาศอธิบดีฯ 199), and with the
    // checkbox hidden at create there was NO path — not this form, not the bulk
    // importer — that could make a member a registrant when they were created.
    // Every member was born a non-registrant. That is how "no member has ever
    // received the branch line" — the defect this entire branch exists to fix —
    // would have quietly returned through a third door.
    //
    // The checkbox now renders in both modes and the payload carries it, so
    // refusing to seed would be actively harmful: the admin picks "Limited
    // company", the box does not tick, and the member is created as a
    // non-registrant.
    expect(
      resolveVatSeed({ code: 'company', vatManuallyTouched: false }),
    ).toBe(true);
  });

  it('never seeds once the admin has hand-touched the checkbox this session', () => {
    expect(
      resolveVatSeed({ code: 'company', vatManuallyTouched: true }),
    ).toBeNull();
    // Even for a code whose default would otherwise be non-null.
    expect(
      resolveVatSeed({ code: 'limited_company', vatManuallyTouched: true }),
    ).toBeNull();
  });

  it('an out-of-catalogue code never seeds (defensive — the Select cannot actually produce one)', () => {
    expect(
      resolveVatSeed({ code: 'nonsense', vatManuallyTouched: false }),
    ).toBeNull();
  });

  it('an empty string ("nothing picked") never seeds', () => {
    expect(
      resolveVatSeed({ code: '', vatManuallyTouched: false }),
    ).toBeNull();
  });
});
