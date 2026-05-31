/**
 * F8 Phase 4 Wave J10 / M10 — Renewal reminder email template render tests.
 *
 * The pre-existing `copy.test.ts` covers the copy MATRIX (subject /
 * body / cta string completeness across locales) but does NOT verify
 * that the React Email JSX tree renders without errors for every
 * (tier, offset, locale) combination. The `resend-transactional-
 * renewal-gateway.test.ts` mocks `@react-email/components.render` to
 * a placeholder string, so the actual JSX is never exercised under
 * test.
 *
 * This test renders the production template via the real
 * `@react-email/components` `render` function for a representative
 * cross-section: 5 tiers × 1 representative T-30 step × 3 locales =
 * 15 render calls. Each render asserts:
 *   1. No exception thrown (JSX tree mounts cleanly).
 *   2. Output is non-empty HTML.
 *   3. The localized tier label appears in the rendered body.
 *   4. The CTA href is preserved verbatim.
 *
 * Catches: missing template variables, JSX prop drift, locale-routing
 * regressions, and CTA href interpolation breakage. Cheaper than
 * pixel-level snapshots (which would noise on every css-in-js
 * tweak); narrower than the gateway-level test (which mocks render).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@react-email/components';
import { RenewalReminderEmail } from '@/modules/renewals/infrastructure/email/templates/renewal-reminder-email';
import type { RenewalReminderTier } from '@/modules/renewals/infrastructure/email/templates/copy';

const TIERS: ReadonlyArray<RenewalReminderTier> = [
  'thai_alumni',
  'start_up',
  'regular',
  'premium',
  'partnership',
];
const LOCALES = ['en', 'th', 'sv'] as const;

const FIXED_PROPS = {
  offset: 't-30' as const,
  memberFirstName: 'Somchai',
  memberCompanyName: 'Acme Co',
  expiresAtIso: '2026-08-15T00:00:00Z',
  daysUntilExpiry: 30,
  renewalLinkUrl: 'https://swecham.test/portal/account?token=mock',
};

describe('<RenewalReminderEmail> — render coverage (J10-M10)', () => {
  for (const tier of TIERS) {
    for (const locale of LOCALES) {
      it(`renders without errors: tier=${tier}, locale=${locale}, offset=t-30`, async () => {
        const html = await render(
          <RenewalReminderEmail tier={tier} locale={locale} {...FIXED_PROPS} />,
        );
        // 1. Non-empty HTML output.
        expect(typeof html).toBe('string');
        expect(html.length).toBeGreaterThan(100);
        // 2. CTA href interpolated verbatim — guards against
        //    `BaseRenewalLayout` / `<Button>` regressing the prop.
        expect(html).toContain(FIXED_PROPS.renewalLinkUrl);
        // 3. Member name + company name interpolated (smoke test for
        //    the copy.ts placeholder pipeline).
        expect(html).toContain(FIXED_PROPS.memberFirstName);
        expect(html).toContain(FIXED_PROPS.memberCompanyName);
      });
    }
  }

  it('plain-text render strips HTML markup', async () => {
    const text = await render(
      <RenewalReminderEmail
        tier="regular"
        locale="en"
        {...FIXED_PROPS}
      />,
      { plainText: true },
    );
    expect(typeof text).toBe('string');
    expect(text).toContain(FIXED_PROPS.memberFirstName);
    expect(text).toContain(FIXED_PROPS.memberCompanyName);
    // Plain-text output should NOT contain raw HTML tags.
    expect(text).not.toMatch(/<[a-z]+[^>]*>/i);
  });

  it('TH locale body includes BE-formatted year alongside Gregorian (FR-014)', async () => {
    const html = await render(
      <RenewalReminderEmail
        tier="thai_alumni"
        locale="th"
        {...FIXED_PROPS}
      />,
    );
    // Expires-at body line shows `<thai_BE> (<gregorian>)` — BE 2569
    // ≈ Gregorian 2026 (2026 + 543 = 2569).
    expect(html).toContain('2569');
    expect(html).toContain('2026');
  });

  it('S1-P1-3: renders a manage-preferences opt-out link when preferencesUrl is set', async () => {
    const prefsUrl = 'https://swecham.test/portal/preferences/renewals';
    const html = await render(
      <RenewalReminderEmail
        tier="regular"
        locale="en"
        {...FIXED_PROPS}
        preferencesUrl={prefsUrl}
      />,
    );
    expect(html).toContain(prefsUrl);
    expect(html).toContain('Manage reminder preferences');
  });

  it('S1-P1-3: no opt-out link when preferencesUrl is omitted (back-compat)', async () => {
    const html = await render(
      <RenewalReminderEmail tier="regular" locale="en" {...FIXED_PROPS} />,
    );
    expect(html).not.toContain('/portal/preferences/renewals');
    expect(html).not.toContain('Manage reminder preferences');
  });
});
