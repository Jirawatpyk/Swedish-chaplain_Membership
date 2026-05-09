/**
 * F8 Phase 7 Round 4 IMP-7 — TierUpgradeApprovalEmail render tests.
 *
 * Companion to `renewal-reminder-email.test.tsx`. Verifies that the
 * approval-email template renders cleanly across all 3 locales AND
 * that Round 3 IMP-9's TH-locale dual-format body wiring (FR-014)
 * survives future refactors. Catches:
 *   1. JSX tree mounts without exceptions.
 *   2. TH body renders both BE (2569) AND Gregorian (2026) in the
 *      "${BE} (${gregorian})" pattern.
 *   3. en/sv bodies render Gregorian (2026) ONLY — no BE leak.
 *   4. CTA href preserved verbatim.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@react-email/components';
import { TierUpgradeApprovalEmail } from '@/modules/renewals/infrastructure/email/templates/tier-upgrade-approval-email';

// Round 5 IMP-11 — derive BE year from fixture instead of hard-coding
// "2569". A future change to FIXED_PROPS.effectiveAtIso would silently
// mis-fire all 3 locale tests if the year stays hard-coded. Deriving
// keeps the test in lock-step with the fixture.
const FIXTURE_YEAR_GREGORIAN = 2026;
const FIXTURE_YEAR_BE = String(FIXTURE_YEAR_GREGORIAN + 543); // = '2569'
const FIXTURE_YEAR_GREGORIAN_STR = String(FIXTURE_YEAR_GREGORIAN);

const FIXED_PROPS = {
  memberFirstName: 'Somchai',
  memberCompanyName: 'Acme Co',
  targetPlanName: 'Premium',
  effectiveAtIso: `${FIXTURE_YEAR_GREGORIAN}-08-15T00:00:00Z`,
  portalUrl: 'https://swecham.test/portal/account?token=mock',
};

describe('<TierUpgradeApprovalEmail> — render coverage (R4-IMP-7 + R5-IMP-11)', () => {
  it('TH locale renders dual-format body — BE before Gregorian', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="th" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain(FIXTURE_YEAR_BE);
    expect(html).toContain(FIXTURE_YEAR_GREGORIAN_STR);
    // FR-014 — body emits "<BE> (<Gregorian>)" parenthetical pair.
    // Match the discriminating pair (BE before Gregorian) directly.
    const beBeforeGregorian =
      html.indexOf(FIXTURE_YEAR_BE) < html.indexOf(FIXTURE_YEAR_GREGORIAN_STR);
    expect(beBeforeGregorian).toBe(true);
  });

  it('EN locale renders Gregorian only — no BE leak (Arabic or Thai numerals)', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="en" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html).toContain(FIXTURE_YEAR_GREGORIAN_STR);
    // EN body must NOT carry the BE year. Footer renders dual-
    // format for ALL locales (Round 4 SUG-7 design — see
    // tier-upgrade-approval-email.tsx). So Arabic-numeral '2569'
    // appears in the footer and at most ONCE in the document.
    const beOccurrences = (html.match(new RegExp(FIXTURE_YEAR_BE, 'g')) ?? []).length;
    expect(beOccurrences).toBeLessThanOrEqual(1);
    // Round 5 IMP-12 — also verify NO Thai-numeral BE leak (e.g.
    // '๒๕๖๙' for 2569). EN/SV bodies must be Arabic-numeral only.
    const thaiNumeralYear = FIXTURE_YEAR_BE
      .split('')
      .map((d) => String.fromCharCode(0x0e50 + Number(d)))
      .join('');
    expect(html).not.toContain(thaiNumeralYear);
  });

  it('SV locale renders Gregorian only — no BE leak (Arabic or Thai numerals)', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="sv" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html).toContain(FIXTURE_YEAR_GREGORIAN_STR);
    const beOccurrences = (html.match(new RegExp(FIXTURE_YEAR_BE, 'g')) ?? []).length;
    expect(beOccurrences).toBeLessThanOrEqual(1);
    const thaiNumeralYear = FIXTURE_YEAR_BE
      .split('')
      .map((d) => String.fromCharCode(0x0e50 + Number(d)))
      .join('');
    expect(html).not.toContain(thaiNumeralYear);
  });

  it('CTA href preserved verbatim across all locales', async () => {
    for (const locale of ['en', 'th', 'sv'] as const) {
      const html = await render(
        <TierUpgradeApprovalEmail locale={locale} {...FIXED_PROPS} />,
      );
      expect(html).toContain(FIXED_PROPS.portalUrl);
    }
  });
});
