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

  // Round 6 S-006 — Helper: split rendered HTML into (body, footer)
  // halves at the footer marker so EN/SV BE-leak assertions can be
  // sharper than the prior `beOccurrences <= 1` guard. The pre-Round-6
  // form would silently allow a BE year in the BODY as long as the
  // total stayed at 1 — this helper ensures the body half NEVER
  // contains BE while the footer (dual-format by Round 4 SUG-7 design)
  // can still carry it once.
  function splitBodyFromFooter(html: string): { body: string; footer: string } {
    // The footer dual-format pair lives in the email's rendered footer
    // section (after the CTA). Slice at the `portalUrl` token (which
    // belongs to the CTA href, marking the body→footer transition);
    // anything after is "footer". When the URL appears multiple times
    // (rare but possible), use the last occurrence.
    const splitIdx = html.lastIndexOf(FIXED_PROPS.portalUrl);
    if (splitIdx === -1) {
      return { body: html, footer: '' };
    }
    return {
      body: html.slice(0, splitIdx),
      footer: html.slice(splitIdx),
    };
  }

  it('EN locale renders Gregorian only in BODY — BE only in FOOTER (Round 6 S-006 split)', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="en" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html).toContain(FIXTURE_YEAR_GREGORIAN_STR);
    const { body, footer } = splitBodyFromFooter(html);
    // Round 6 S-006 — BODY must NEVER contain the BE year. The prior
    // `beOccurrences <= 1` guard could mask a body-leak when total
    // stayed at 1 (e.g., body=1, footer=0 instead of body=0, footer=1).
    expect(body).not.toContain(FIXTURE_YEAR_BE);
    // Footer carries the BE year exactly once (dual-format design).
    expect(footer).toContain(FIXTURE_YEAR_BE);
    // Round 5 IMP-12 lock — NO Thai-numeral BE leak anywhere.
    const thaiNumeralYear = FIXTURE_YEAR_BE
      .split('')
      .map((d) => String.fromCharCode(0x0e50 + Number(d)))
      .join('');
    expect(html).not.toContain(thaiNumeralYear);
  });

  it('SV locale renders Gregorian only in BODY — BE only in FOOTER (Round 6 S-006 split)', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="sv" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html).toContain(FIXTURE_YEAR_GREGORIAN_STR);
    const { body, footer } = splitBodyFromFooter(html);
    expect(body).not.toContain(FIXTURE_YEAR_BE);
    expect(footer).toContain(FIXTURE_YEAR_BE);
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
