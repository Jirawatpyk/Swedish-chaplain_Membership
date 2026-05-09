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

const FIXED_PROPS = {
  memberFirstName: 'Somchai',
  memberCompanyName: 'Acme Co',
  targetPlanName: 'Premium',
  effectiveAtIso: '2026-08-15T00:00:00Z',
  portalUrl: 'https://swecham.test/portal/account?token=mock',
};

describe('<TierUpgradeApprovalEmail> — render coverage (R4-IMP-7)', () => {
  it('TH locale renders dual-format body — BE 2569 + Gregorian 2026', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="th" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('2569');
    expect(html).toContain('2026');
    // FR-014 — body emits "<BE> (<Gregorian>)" parenthetical pair.
    // Match the discriminating pair (BE before Gregorian) directly.
    const beBeforeGregorian =
      html.indexOf('2569') < html.indexOf('2026');
    expect(beBeforeGregorian).toBe(true);
  });

  it('EN locale renders Gregorian only — no BE leak', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="en" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html).toContain('2026');
    // EN body must NOT carry the BE year. Footer renders dual-
    // format for ALL locales, but body should be Gregorian-only
    // for EN per the approval-email contract.
    // Footer DOES carry 2569 in all locales; check that BE
    // appears at most once in the entire document (footer only).
    const beOccurrences = (html.match(/2569/g) ?? []).length;
    expect(beOccurrences).toBeLessThanOrEqual(1);
  });

  it('SV locale renders Gregorian only — no BE leak', async () => {
    const html = await render(
      <TierUpgradeApprovalEmail locale="sv" {...FIXED_PROPS} />,
    );
    expect(html).toBeTruthy();
    expect(html).toContain('2026');
    const beOccurrences = (html.match(/2569/g) ?? []).length;
    expect(beOccurrences).toBeLessThanOrEqual(1);
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
